/**
 * Prompt attachment preparation for the main process.
 *
 * Resolves renderer-supplied attachment paths against the session roots
 * (project, session scratch, content-addressed attachments), stores image
 * bytes as content-addressed blobs, and decides whether an image is inlined
 * for a vision-capable model or handed to the agent as a file reference.
 */
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { resolveComposerFileReference } from "./composer-file-references.ts";
import {
  ErrorCodes,
  appendLocalFileReferenceContext,
  fileLineLabel,
  MAX_FILE_LINE_REFERENCES,
  parseFileLineRange,
  formatFileInsert,
  formatPromptPathText,
  imageExceedsInlineDimensions,
  isSvgAttachment,
  locateInlinePromptPaths,
  probeImageDimensions,
  SVG_MIME_TYPE,
  MAX_INLINE_IMAGE_BYTES,
  type AgentPromptAttachment,
  type MessageAttachment,
} from "@pi-desktop/shared";
import { fileLinePathInProject } from "./file-line-reference.ts";

export { MAX_INLINE_IMAGE_BYTES } from "@pi-desktop/shared";

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
]);
const IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};
type PromptPath = {
  absolute: string;
  root: "project" | "scratch" | "attachment";
};

/** Recording containers `audio/transcriptions` endpoints commonly accept. */
const AUDIO_EXTENSIONS = new Set([
  "aac", "aiff", "amr", "flac", "m4a", "m4b", "mp3", "oga", "ogg", "opus", "wav", "wma",
]);

export type PreparedPromptAttachment = {
  message: MessageAttachment;
  fallbackPath: string;
  inlineData?: string;
  /**
   * Text of an attached recording, when transcription is configured. The agent
   * cannot hear, so without this the attachment travels as a bare path.
   */
  transcript?: { text: string; chunks: number; converted: boolean };
  /** Why transcription did not happen, stated in the prompt rather than swallowed. */
  transcriptError?: string;
};

export type PromptAttachmentOptions = {
  /** Transcribe one recording; resolve with `{ error }` instead of throwing when it fails. */
  transcribeAudio?: (input: {
    path: string;
    mimeType?: string;
    name: string;
  }) => Promise<
    { text: string; chunks: number; converted: boolean } | { error: string }
  >;
};

function isAudioPromptAttachment(
  attachment: AgentPromptAttachment,
  path: string,
): boolean {
  const mimeType = promptMimeType(path, attachment.mimeType, attachment.name);
  if (mimeType.startsWith("audio/")) return true;
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.has(extension);
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function promptMimeType(path: string, supplied?: string, name?: string): string {
  if (isSvgAttachment(supplied, path, name)) return SVG_MIME_TYPE;
  const value = supplied?.trim().toLowerCase();
  if (value) return value;
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function isImagePromptAttachment(
  attachment: AgentPromptAttachment,
  path: string,
): boolean {
  const mimeType = promptMimeType(path, attachment.mimeType, attachment.name);
  if (mimeType === SVG_MIME_TYPE) return false;
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return (
    attachment.kind === "image" ||
    mimeType.startsWith("image/") ||
    IMAGE_MIME_TYPES.has(mimeType) ||
    IMAGE_EXTENSIONS.has(extension)
  );
}

function resolvePromptPath(
  dataRoot: string,
  sessionId: string,
  projectPath: string | undefined,
  rawPath: string,
): PromptPath | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;
  const scratchRoot = join(dataRoot, "scratch", sessionId);
  const attachmentRoot = join(dataRoot, "attachments");
  const roots: Array<{ path: string; root: PromptPath["root"] }> = [
    { path: scratchRoot, root: "scratch" },
    { path: attachmentRoot, root: "attachment" },
    ...(projectPath ? [{ path: projectPath, root: "project" as const }] : []),
  ];
  const candidate = isAbsolute(trimmed)
    ? resolve(trimmed)
    : trimmed.startsWith("attachments/")
      ? resolve(dataRoot, trimmed)
      : projectPath
        ? resolve(projectPath, trimmed)
        : undefined;
  if (!candidate) return undefined;
  const realCandidate = canonicalPath(candidate);
  if (!realCandidate) return undefined;
  for (const entry of roots) {
    const realRoot = canonicalPath(entry.path);
    if (realRoot && pathInside(realRoot, realCandidate)) {
      try {
        if (!statSync(realCandidate).isFile()) return undefined;
      } catch {
        return undefined;
      }
      return { absolute: realCandidate, root: entry.root };
    }
  }
  return undefined;
}

function displayPromptPath(
  promptPath: PromptPath,
  projectPath: string | undefined,
): string {
  if (promptPath.root !== "project" || !projectPath) return promptPath.absolute;
  const relativePath = relative(projectPath, promptPath.absolute);
  return relativePath && !relativePath.startsWith("..")
    ? relativePath
    : promptPath.absolute;
}

function ensureAttachmentBlob(dataRoot: string, bytes: Buffer): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const root = join(dataRoot, "attachments");
  mkdirSync(root, { recursive: true });
  const target = join(root, hash);
  if (!existsSync(target)) {
    try {
      writeFileSync(target, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  return `attachments/${hash}`;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function ensureAttachmentBlobFromFile(
  dataRoot: string,
  source: string,
): Promise<string> {
  const hash = await hashFile(source);
  const root = join(dataRoot, "attachments");
  mkdirSync(root, { recursive: true });
  const target = join(root, hash);
  if (!existsSync(target)) {
    try {
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  return `attachments/${hash}`;
}

async function fallbackPathForStoredAttachment(
  dataRoot: string,
  sessionId: string,
  source: PromptPath,
  name: string,
): Promise<string> {
  if (source.root !== "attachment") return source.absolute;
  const root = join(dataRoot, "scratch", sessionId, "replayed");
  mkdirSync(root, { recursive: true });
  const safeName = name.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "attachment";
  const target = join(root, `${safeName}-${createHash("sha256").update(source.absolute).digest("hex").slice(0, 12)}`);
  if (!existsSync(target)) {
    try {
      await copyFile(source.absolute, target, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  return target;
}

export async function preparePromptAttachments(
  dataRoot: string,
  sessionId: string,
  projectPath: string | undefined,
  attachments: readonly AgentPromptAttachment[],
  supportsVision: boolean,
  /**
   * The prompt text this input carries, with the attachment chips the Composer
   * left inline. An image named there keeps that text on the durable message and
   * in the prompt, instead of being appended after the body.
   */
  promptContent: string,
  options?: PromptAttachmentOptions,
): Promise<PreparedPromptAttachment[]> {
  const prepared: PreparedPromptAttachment[] = [];
  if (attachments.filter(attachment => attachment.lineRange !== undefined).length > MAX_FILE_LINE_REFERENCES) {
    throw Object.assign(new Error("Too many file line references"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
  }
  // Reference order is the user's order, so each entry takes the next matching
  // `@path` text the prompt holds.
  const inlineSpans = locateInlinePromptPaths(
    promptContent,
    attachments.map((attachment) => attachment.path),
  );
  for (const [index, attachment] of attachments.entries()) {
    if (attachment.lineRange !== undefined) {
      if (attachment.localReference !== undefined) {
        throw Object.assign(new Error("File references cannot combine a line range and local reference"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const lineRange = parseFileLineRange(attachment.lineRange);
      if (!lineRange || attachment.kind !== "file" || !fileLinePathInProject(attachment.path, projectPath ?? null)) {
        throw Object.assign(new Error("Invalid file line reference for the session project"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const name = attachment.name || attachment.path.split(/[\\/]/).at(-1) || "file";
      const inlinePath = fileLineLabel(attachment.path, lineRange);
      prepared.push({
        message: { kind: "file", name, ref: attachment.path, lineRange, inlinePath },
        fallbackPath: attachment.path,
      });
      continue;
    }
    if (attachment.localReference !== undefined) {
      const file = await resolveComposerFileReference(dataRoot, projectPath, attachment.path, attachment.localReference);
      prepared.push({
        message: {
          kind: "file", name: file.name, ref: file.path, mimeType: file.mimeType,
          size: file.size, localReference: file.localReference,
          ...(inlineSpans[index] ? { inlinePath: formatPromptPathText(file.path) } : {}),
        },
        fallbackPath: file.path,
      });
      continue;
    }
    const source = resolvePromptPath(dataRoot, sessionId, projectPath, attachment.path);
    if (!source) {
      throw Object.assign(new Error(`Attachment path is outside the session roots: ${attachment.path}`), {
        errorCode: ErrorCodes.PATH_OUTSIDE_WORKSPACE,
      });
    }
    const name = attachment.name.trim() || source.absolute.split(/[\\/]/).at(-1) || "attachment";
    const mimeType = promptMimeType(source.absolute, attachment.mimeType, name);
    const isImage = isImagePromptAttachment(attachment, source.absolute);
    if (!isImage) {
      const entry: PreparedPromptAttachment = {
        message: {
          kind: "file",
          name,
          ref: attachment.path,
          ...(mimeType !== "application/octet-stream" ? { mimeType } : {}),
          ...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
        },
        fallbackPath: mimeType === SVG_MIME_TYPE && source.root === "attachment"
          ? await fallbackPathForStoredAttachment(dataRoot, sessionId, source, name)
          : displayPromptPath(source, projectPath),
      };
      // A recording becomes text before the prompt is sent; the file reference
      // stays, so the agent can still reach the original audio.
      if (options?.transcribeAudio && isAudioPromptAttachment(attachment, source.absolute)) {
        try {
          const result = await options.transcribeAudio({
            path: source.absolute,
            mimeType,
            name,
          });
          if ("error" in result) entry.transcriptError = result.error;
          else entry.transcript = result;
        } catch (error) {
          entry.transcriptError = (error as Error).message ?? String(error);
        }
      }
      prepared.push(entry);
      continue;
    }

    const size = statSync(source.absolute).size;
    const read = supportsVision && size <= MAX_INLINE_IMAGE_BYTES
      ? await readFile(source.absolute)
      : undefined;
    // A provider rejects an image past its pixel limit even when the bytes are
    // small; it takes the `@path` fallback instead of poisoning history (#1913).
    const bytes = read && !imageExceedsInlineDimensions(probeImageDimensions(read))
      ? read
      : undefined;
    const inline = bytes !== undefined;
    const ref =
      source.root === "attachment" && attachment.path.trim().startsWith("attachments/")
        ? attachment.path.trim()
        : read
          ? ensureAttachmentBlob(dataRoot, read)
          : await ensureAttachmentBlobFromFile(dataRoot, source.absolute);
    // The user's own position for this image: the draft named its path between
    // words, so the text stays in the prompt and the transcript renders the
    // image there.
    const inlinePath = inlineSpans[index]
      ? formatPromptPathText(attachment.path)
      : undefined;
    const fallbackPath = inline
      ? displayPromptPath(source, projectPath)
      : await fallbackPathForStoredAttachment(
          dataRoot,
          sessionId,
          source,
          name,
        );
    prepared.push({
      message: {
        kind: "image",
        name,
        ref,
        mimeType,
        size,
        ...(inlinePath ? { inlinePath } : {}),
      },
      fallbackPath,
      ...(bytes
        ? { inlineData: bytes.toString("base64") }
        : {}),
    });
  }
  return prepared;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Use the renderer's id for the new user row when it is a UUID the session
 * does not already hold (D288); otherwise mint one. The renderer inserted its
 * optimistic row under that id, so the durable echo lands on the same row.
 */
export function durableUserMessageId(
  requested: unknown,
  existing: ReadonlyArray<{ id?: unknown }>,
): string {
  if (
    typeof requested === "string" &&
    UUID_PATTERN.test(requested) &&
    !existing.some((message) => message?.id === requested)
  ) {
    return requested;
  }
  return crypto.randomUUID();
}

export function appendPromptFallbackPaths(
  content: string,
  attachments: readonly PreparedPromptAttachment[],
): string {
  const paths = attachments
    .filter((attachment) => !attachment.inlineData && !attachment.message.localReference && !attachment.message.lineRange)
    // A path the prompt already names at the user's own position needs no second
    // copy at the end; a rewritten fallback (a replayed copy) still travels.
    .filter(
      (attachment) =>
        attachment.message.inlinePath !== formatPromptPathText(attachment.fallbackPath),
    )
    .map((attachment) => formatFileInsert(attachment.fallbackPath, "file"))
    .join("")
    .trim();
  const transcripts = attachments
    .filter((attachment) => attachment.transcript || attachment.transcriptError)
    .map((attachment) => {
      const label = attachment.message.name;
      if (!attachment.transcript) {
        return `[录音转写失败：${label}｜${attachment.transcriptError}]`;
      }
      const { chunks, converted } = attachment.transcript;
      const how = [label, `${chunks} 段`, converted ? "已用 ffmpeg 重编码" : "原音频"]
        .join("｜");
      return `[录音转写：${how}｜自动语音识别，专有名词可能有误]\n${attachment.transcript.text}`;
    })
    .join("\n\n");
  const text = content.trim();
  return appendLocalFileReferenceContext(
    [text, paths, transcripts].filter(Boolean).join("\n"),
    attachments.map(attachment => ({ ...attachment.message, path: attachment.fallbackPath })));
}
