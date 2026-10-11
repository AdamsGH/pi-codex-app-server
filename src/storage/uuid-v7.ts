import { randomBytes } from "node:crypto";

export const uuidV7 = (): string => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = 0x70 + ((bytes[6] ?? 0) % 16);
  bytes[8] = 0x80 + ((bytes[8] ?? 0) % 64);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};
