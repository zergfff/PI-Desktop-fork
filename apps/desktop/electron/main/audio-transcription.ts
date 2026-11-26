/**
 * Transcription of audio the user attached to a prompt.
 *
 * The agent cannot hear: an audio attachment reaches it as a file path. This
 * module turns that path into text before the prompt is sent, through an
 * OpenAI-compatible `audio/transcriptions` endpoint — a hosted service, or a
 * local whisper server that speaks the same protocol. Nothing here picks a
 * provider: with no endpoint configured the caller keeps the plain file
 * reference it always had.
 *
 * Two limits shape the pipeline. The endpoint takes one file per request, and an
 * hour of speech will not arrive in one call, so anything past the request cap
 * (or in a container the endpoint rejects, such as the `.aac` WeChat records) is
 * re-encoded to 16 kHz mono mp3 and split with ffmpeg, then transcribed in
 * order with a `[mm:ss]` stamp per chunk so the text still lines up with the
 * recording.
 *
 * Configuration, first match wins:
 *   1. `<data dir>/audio-transcription.json` — `{ baseUrl, apiKey?, apiKeyEnv?,
 *      model?, language?, ffmpegPath?, chunkSeconds? }`
 *   2. environment — `PI_ASR_BASE_URL`, `PI_ASR_API_KEY`, `PI_ASR_MODEL`,
 *      `PI_ASR_LANGUAGE`, `PI_FFMPEG_PATH`
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Default minutes per request; keeps chunks small enough to finish promptly. */
const DEFAULT_CHUNK_SECONDS = 600;

/** A single attachment past this size is refused rather than chewed through. */
const MAX_AUDIO_BYTES = 800_000_000;

/** Transcripts are prompt text; one recording must not crowd out everything else. */
const MAX_TRANSCRIPT_CHARS = 200_000;

/** Per-request byte ceiling the hosted APIs enforce. */
const MAX_REQUEST_BYTES = 25_000_000;

/** Containers `audio/transcriptions` accepts without re-encoding. */
const PASSTHROUGH_EXTENSIONS = new Set([
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "ogg",
  "wav",
  "webm",
]);

export const AUDIO_CONFIG_FILE = "audio-transcription.json";

export type AudioTranscriptionConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  language?: string;
  ffmpegPath?: string;
  chunkSeconds?: number;
};

type StoredConfig = {
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  language?: string;
  ffmpegPath?: string;
  chunkSeconds?: number;
};

export type AudioTranscription = {
  /** Transcript text, chunk stamps included. */
  text: string;
  /** Requests the endpoint took. */
  chunks: number;
  /** True when ffmpeg re-encoded and split the source. */
  converted: boolean;
};

function fail(message: string): never {
  throw Object.assign(new Error(message), { errorCode: "AUDIO_TRANSCRIPTION_FAILED" });
}

function extensionOf(path: string): string {
  return path.split(".").at(-1)?.toLowerCase() ?? "";
}

/** Absolute path of the configuration file inside the data directory. */
export function audioConfigPath(dataDir: string): string {
  return join(dataDir, AUDIO_CONFIG_FILE);
}

/**
 * Read the endpoint configuration.
 *
 * Returns `undefined` when no base URL is configured anywhere — the caller then
 * leaves audio attachments as file references instead of failing every prompt.
 */
export function readAudioConfig(dataDir: string): AudioTranscriptionConfig | undefined {
  let stored: StoredConfig = {};
  const file = audioConfigPath(dataDir);
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, "utf8")) as StoredConfig;
    } catch {
      fail(`${AUDIO_CONFIG_FILE} 不是合法 JSON`);
    }
  }
  const baseUrl = (stored.baseUrl ?? process.env.PI_ASR_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return undefined;
  const apiKeyEnv = stored.apiKeyEnv?.trim();
  const apiKey =
    stored.apiKey?.trim() ||
    (apiKeyEnv ? process.env[apiKeyEnv]?.trim() : undefined) ||
    process.env.PI_ASR_API_KEY?.trim() ||
    undefined;
  const chunkSeconds = Number(stored.chunkSeconds);
  return {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    model: (stored.model ?? process.env.PI_ASR_MODEL ?? "whisper-1").trim(),
    language: (stored.language ?? process.env.PI_ASR_LANGUAGE ?? "zh").trim(),
    ...(stored.ffmpegPath ? { ffmpegPath: stored.ffmpegPath } : {}),
    ...(Number.isFinite(chunkSeconds) && chunkSeconds >= 30 ? { chunkSeconds } : {}),
  };
}

/** Write a starter configuration so there is a file to edit. */
export function writeAudioConfigTemplate(dataDir: string): string {
  const file = audioConfigPath(dataDir);
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    const template: StoredConfig = {
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "PI_ASR_API_KEY",
      model: "whisper-1",
      language: "zh",
      ffmpegPath: "",
      chunkSeconds: DEFAULT_CHUNK_SECONDS,
    };
    writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  }
  return file;
}

/** Locate ffmpeg: the configured path, the environment, then PATH. */
export async function resolveFfmpeg(explicit?: string): Promise<string | undefined> {
  const candidates = [explicit?.trim(), process.env.PI_FFMPEG_PATH?.trim(), "ffmpeg"].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      await run(candidate, ["-version"], { timeout: 15_000, windowsHide: true });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function stamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** One multipart call to the endpoint; returns the transcript text. */
async function postTranscription(
  config: AudioTranscriptionConfig,
  file: { path: string; mimeType: string },
): Promise<string> {
  const bytes = readFileSync(file.path);
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    fail(`分片仍有 ${Math.round(bytes.byteLength / 1e6)} MB，超过接口上限`);
  }
  const name = file.path.split(/[\\/]/).at(-1) || "audio";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: file.mimeType }), name);
  form.append("model", config.model);
  if (config.language) form.append("language", config.language);
  const url = `${config.baseUrl}/audio/transcriptions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
  } catch (error) {
    fail(`转写请求失败：${(error as Error).message ?? String(error)}`);
  }
  const raw = await response.text();
  if (!response.ok) fail(`转写接口 ${response.status}：${raw.slice(0, 400)}`);
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    // some servers answer with the bare transcript
  }
  return raw;
}

/**
 * Transcribe one attachment.
 *
 * Throws with `AUDIO_TRANSCRIPTION_FAILED` when the file is too large, when a
 * conversion is needed but ffmpeg is nowhere, or when the endpoint rejects a
 * chunk — the caller turns that into a note on the prompt instead of dropping
 * the attachment.
 */
export async function transcribeAudioAttachment(input: {
  path: string;
  mimeType?: string;
  config: AudioTranscriptionConfig;
  /** Session scratch directory the chunks are written under. */
  scratchDir: string;
  log?: (message: string) => void;
}): Promise<AudioTranscription> {
  const { config } = input;
  const source = input.path;
  if (!existsSync(source)) fail(`音频文件不存在：${source}`);
  const size = statSync(source).size;
  if (size > MAX_AUDIO_BYTES) {
    fail(`音频过大：${Math.round(size / 1e6)} MB，上限 ${Math.round(MAX_AUDIO_BYTES / 1e6)} MB`);
  }
  const extension = extensionOf(source);
  const mimeType = input.mimeType?.startsWith("audio/")
    ? input.mimeType
    : `audio/${extension || "mpeg"}`;

  if (PASSTHROUGH_EXTENSIONS.has(extension) && size <= MAX_REQUEST_BYTES) {
    const text = await postTranscription(config, { path: source, mimeType });
    return { text: text.trim().slice(0, MAX_TRANSCRIPT_CHARS), chunks: 1, converted: false };
  }

  const ffmpeg = await resolveFfmpeg(config.ffmpegPath);
  if (!ffmpeg) {
    fail(
      `需要 ffmpeg 转换 ${extension || "该格式"}（超过 25 MB 或接口不收的容器）。可在 ${AUDIO_CONFIG_FILE} 的 ffmpegPath 指定路径，或设置环境变量 PI_FFMPEG_PATH`,
    );
  }
  const key = source.replace(/[^\p{L}\p{N}]+/gu, "_").slice(-48);
  const dir = join(input.scratchDir, "audio-transcription", key);
  mkdirSync(dir, { recursive: true });
  const chunkSeconds = config.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", source,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "64k",
      "-f", "segment",
      "-segment_time", String(chunkSeconds),
      "-reset_timestamps", "1",
      join(dir, "chunk-%03d.mp3"),
    ],
    { timeout: 2 * 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  const chunks = readdirSync(dir)
    .filter((name) => name.startsWith("chunk-") && name.endsWith(".mp3"))
    .sort();
  if (!chunks.length) fail("ffmpeg 没有产出任何音频分片");

  const parts: string[] = [];
  let chars = 0;
  for (const [index, name] of chunks.entries()) {
    if (chars >= MAX_TRANSCRIPT_CHARS) {
      parts.push(`[已截断：转写文本超过 ${MAX_TRANSCRIPT_CHARS} 字符，其余分片未转写]`);
      break;
    }
    const text = (
      await postTranscription(config, { path: join(dir, name), mimeType: "audio/mpeg" })
    ).trim();
    input.log?.(`audio chunk ${index + 1}/${chunks.length}: ${text.length} chars`);
    parts.push(chunks.length > 1 ? `[${stamp(index * chunkSeconds)}] ${text}` : text);
    chars += text.length;
  }
  return { text: parts.join("\n\n"), chunks: chunks.length, converted: true };
}
