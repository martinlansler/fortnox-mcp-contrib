import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveLocalPath, checkLinkTarget, findLocalFile, checkUploadName, registerFileTools, uploadSearchDirs } from "./files.js";

describe("resolveLocalPath", () => {
  it("maps Windows paths to WSL", () => {
    expect(resolveLocalPath("C:\\Users\\alice\\Downloads\\invoice 1.pdf", "/home/alice", "linux"))
      .toBe("/mnt/c/Users/alice/Downloads/invoice 1.pdf");
    expect(resolveLocalPath("\"D:/Receipts/a.pdf\"", "/home/alice", "linux")).toBe("/mnt/d/Receipts/a.pdf");
  });
  it("expands ~ and file:// URLs, and leaves POSIX paths alone", () => {
    expect(resolveLocalPath("~/docs/a.pdf", "/home/alice", "linux")).toBe("/home/alice/docs/a.pdf");
    expect(resolveLocalPath("file:///C:/Users/a/a%20b.pdf", "/home/alice", "linux")).toBe("/mnt/c/Users/a/a b.pdf");
    expect(resolveLocalPath("/mnt/c/x.pdf", "/home/alice", "linux")).toBe("/mnt/c/x.pdf");
  });
  it("keeps Windows paths on Windows", () => {
    expect(resolveLocalPath("C:\\x.pdf", "C:\\Users\\a", "win32")).toBe("C:\\x.pdf");
  });
});

describe("checkLinkTarget", () => {
  it("accepts an invoice or a complete voucher", () => {
    expect(checkLinkTarget({ given_number: "9" })).toBe("invoice");
    expect(checkLinkTarget({ voucher_series: "A", voucher_number: 2, voucher_year: 1 })).toBe("voucher");
  });
  it("rejects both, neither or an incomplete voucher", () => {
    expect(() => checkLinkTarget({ given_number: "9", voucher_series: "A" })).toThrow(/not both/);
    expect(() => checkLinkTarget({})).toThrow(/needs/);
    expect(() => checkLinkTarget({ voucher_series: "A", voucher_number: 2 })).toThrow(/needs/);
  });
});

describe("findLocalFile", () => {
  it("finds a bare name in the upload folders, newest first, and keeps full paths", async () => {
    const a = await mkdtemp(join(tmpdir(), "fx-a-"));
    const b = await mkdtemp(join(tmpdir(), "fx-b-"));
    await writeFile(join(a, "f.pdf"), "old");
    await writeFile(join(b, "f.pdf"), "new");
    await utimes(join(a, "f.pdf"), 1000, 1000);
    expect(await findLocalFile("f.pdf", [a, b])).toBe(join(b, "f.pdf"));
    expect(await findLocalFile(join(a, "f.pdf"), [b])).toBe(join(a, "f.pdf"));
    await expect(findLocalFile("missing.pdf", [a])).rejects.toThrow(/Found no file/);
  });
  it("finds 'x (1).pdf' when it is given as 'x 1.pdf' or 'x_1.pdf'", async () => {
    const d = await mkdtemp(join(tmpdir(), "fx-l-"));
    await writeFile(join(d, "receipt-2026-01 (1).pdf"), "x");
    expect(await findLocalFile("receipt-2026-01 1.pdf", [d])).toBe(join(d, "receipt-2026-01 (1).pdf"));
    expect(await findLocalFile("receipt-2026-01_1.pdf", [d])).toBe(join(d, "receipt-2026-01 (1).pdf"));
  });
});

describe("uploadSearchDirs", () => {
  it("searches Downloads and Desktop in the home folder, or only FORTNOX_UPLOAD_DIRS", async () => {
    const dirs = await uploadSearchDirs({}, "/home/alice");
    expect(dirs.slice(0, 2)).toEqual(["/home/alice/Downloads", "/home/alice/Desktop"]);
    expect(await uploadSearchDirs({ FORTNOX_UPLOAD_DIRS: "~/inbox; /tmp/x" }, "/home/alice")).toEqual(["/home/alice/inbox", "/tmp/x"]);
  });
});

describe("checkUploadName", () => {
  it("accepts PDFs and images and refuses anything else", () => {
    expect(checkUploadName("invoice.PDF")).toBe("application/pdf");
    expect(() => checkUploadName("/proc/self/environ")).toThrow(/Only PDF and image/);
    expect(() => checkUploadName("/home/alice/.ssh/id_rsa")).toThrow(/Only PDF and image/);
  });
});

describe("registerFileTools", () => {
  const tools = (allowLocalFiles: boolean) => {
    const server = new McpServer({ name: "test", version: "0" });
    registerFileTools(server, { allowLocalFiles });
    return (server as unknown as { _registeredTools: Record<string, { inputSchema: { shape: Record<string, unknown> } }> })._registeredTools;
  };
  it("offers path-based upload only when local files are allowed", () => {
    const local = tools(true);
    expect(local.fortnox_upload_files).toBeDefined();
    expect("file_path" in local.fortnox_upload_to_inbox.inputSchema.shape).toBe(true);
    const remote = tools(false);
    expect(remote.fortnox_upload_files).toBeUndefined();
    expect("file_path" in remote.fortnox_upload_to_inbox.inputSchema.shape).toBe(false);
  });
});
