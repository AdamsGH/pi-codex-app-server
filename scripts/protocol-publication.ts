import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProtocolPublication {
  candidate: string;
  candidateMap: string;
  vendor: string;
  methodMap: string;
  transaction: string;
}

export const publishProtocolSnapshot = async (
  input: ProtocolPublication,
  move: typeof rename = rename
): Promise<void> => {
  const transaction = path.resolve(input.transaction);
  const paths = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, path.resolve(value)])
  );
  for (const staged of [paths.candidate, paths.candidateMap]) {
    if (!staged || !staged.startsWith(`${transaction}${path.sep}`)) {
      throw new Error(
        "Protocol candidate is outside its transaction directory"
      );
    }
  }
  if (
    path.resolve(input.vendor).startsWith(`${transaction}${path.sep}`) ||
    path.resolve(input.methodMap).startsWith(`${transaction}${path.sep}`)
  ) {
    throw new Error("Protocol destination overlaps its transaction directory");
  }
  await mkdir(transaction, { recursive: true });
  const previous = path.join(transaction, "previous-vendor");
  const previousMap = path.join(transaction, "previous-methods.ts");
  const marker = path.join(transaction, "publication.json");
  await writeFile(marker, JSON.stringify({ ...input, phase: "prepared" }));
  let vendorMoved = false;
  let vendorPublished = false;
  let mapCopied = false;
  try {
    await copyFile(input.methodMap, previousMap);
    mapCopied = true;
    await move(input.vendor, previous);
    vendorMoved = true;
    await move(input.candidate, input.vendor);
    vendorPublished = true;
    await move(input.candidateMap, input.methodMap);
    await writeFile(marker, JSON.stringify({ ...input, phase: "complete" }));
  } catch (error) {
    try {
      if (mapCopied) {
        await copyFile(previousMap, input.methodMap);
      }
      if (vendorMoved) {
        if (vendorPublished) {
          await move(input.vendor, path.join(transaction, "rejected-vendor"));
        }
        await move(previous, input.vendor);
      }
      await writeFile(
        marker,
        JSON.stringify({ ...input, phase: "rolled-back" })
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Protocol publication and rollback failed. Inspect ${transaction}`,
        { cause: rollbackError }
      );
    }
    throw new Error(
      `Protocol publication failed and was rolled back. Inspect ${transaction}`,
      { cause: error }
    );
  }
};
