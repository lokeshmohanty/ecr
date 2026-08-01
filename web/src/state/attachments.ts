import type { Attachment } from "../api/types";

/** Matches `MAX_ATTACHMENT_BYTES` in ecr-core, which refuses anything larger. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function attachmentBytes(attachment: Attachment): number {
  const padding = /=*$/.exec(attachment.data_b64)?.[0].length ?? 0;
  return Math.max(Math.floor(attachment.data_b64.length / 4) * 3 - Math.min(padding, 2), 0);
}

export function totalBytes(attachments: Attachment[]): number {
  return attachments.reduce((sum, a) => sum + attachmentBytes(a), 0);
}

/**
 * Why a file cannot be attached, or null when it can. Checked here as well as
 * on the server so the refusal arrives before a 25MB upload does.
 */
export function refuseReason(existing: Attachment[], incoming: number): string | null {
  if (incoming === 0) return "that file is empty";
  if (totalBytes(existing) + incoming > MAX_ATTACHMENT_BYTES) {
    return `attachments would exceed ${formatSize(MAX_ATTACHMENT_BYTES)}`;
  }
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/**
 * Base64 in chunks: `String.fromCharCode(...bytes)` on a whole file blows the
 * argument limit somewhere around a megabyte, which is well inside the range
 * of an ordinary attachment.
 */
export function encodeBytes(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function toAttachment(file: File): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    // A pasted image arrives as "image.png" with no name of its own.
    filename: file.name || `pasted-${Date.now()}.${extensionFor(file.type)}`,
    content_type: file.type || "application/octet-stream",
    data_b64: encodeBytes(bytes),
  };
}

function extensionFor(contentType: string): string {
  const subtype = contentType.split("/")[1] ?? "bin";
  return subtype.split("+")[0] ?? "bin";
}
