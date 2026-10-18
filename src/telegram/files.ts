export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`file is larger than ${maxBytes} bytes`);
    this.name = "FileTooLargeError";
  }
}

/**
 * Downloads a Telegram file. The download URL contains the bot token, so it
 * never appears in an error message or a log.
 */
export async function downloadTelegramFile(args: {
  api: { getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }> };
  token: string;
  fileId: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  const { api, token, fileId, maxBytes, fetchImpl = fetch, signal } = args;
  const file = await api.getFile(fileId);
  if (file.file_size !== undefined && file.file_size > maxBytes) {
    throw new FileTooLargeError(maxBytes);
  }
  if (!file.file_path) throw new Error("telegram file has no path");
  // Network errors can echo the token-bearing URL: never let one escape.
  const failed = () => new Error("telegram file download failed");
  let res: Response;
  try {
    res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      signal,
    });
  } catch {
    throw failed();
  }
  if (!res.ok) throw new Error(`telegram file download failed (HTTP ${res.status})`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new FileTooLargeError(maxBytes);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    throw failed();
  }
  if (bytes.byteLength > maxBytes) throw new FileTooLargeError(maxBytes);
  return bytes;
}
