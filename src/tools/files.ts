/**
 * Fortnox inbox uploads and file connections (attaching a file to a supplier
 * invoice or a voucher as its supporting document).
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, fortnoxRequest, fortnoxUpload } from "../services/api.js";
import { buildToolResponse, buildErrorResponse } from "../services/formatters.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function json(output: unknown) {
  return buildToolResponse(JSON.stringify(output, null, 2), output as Record<string, unknown>);
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff"
};

const LinkTargetSchema = z.object({
  given_number: z.string().min(1).optional().describe("Link to this supplier invoice (löpnummer)"),
  voucher_series: z.string().min(1).max(2).optional().describe("Link to this voucher: series"),
  voucher_number: z.number().int().min(1).optional().describe("Link to this voucher: number"),
  voucher_year: z.number().int().min(1).optional().describe("Link to this voucher: Fortnox financial year ID")
}).strict();

const UploadSchema = z.object({
  file_path: z.string().min(1).optional()
    .describe("Path to the file on the machine running this MCP server. Windows paths (C:\\Users\\...) and ~ are accepted and mapped to WSL when the server runs there."),
  content_base64: z.string().min(1).optional().describe("File content as base64 (alternative to file_path)"),
  file_name: z.string().min(1).max(200).optional().describe("File name; required with content_base64"),
  folder_id: z.string().max(100).optional().describe("Inbox folder id (from fortnox_list_inbox); default is the inbox root"),
  link_to: LinkTargetSchema.optional().describe("Also link the uploaded file to a supplier invoice or a voucher, in the same call")
}).strict();

const UploadFilesSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1).describe("Path on this machine (Windows, WSL or ~), or a bare file name to find in Downloads/Desktop"),
    link_to: LinkTargetSchema.optional()
  }).strict()).min(1).max(100).optional().describe("Files to upload, each optionally linked"),
  directory: z.string().min(1).optional()
    .describe("Upload every PDF/image in this directory (not recursive) instead of listing files"),
  folder_id: z.string().max(100).optional().describe("Inbox folder id; default is the inbox root")
}).strict();
// Cross-field rules are checked in the handler: a top-level .refine() would turn
// this into a ZodEffects and the MCP SDK would advertise an empty input schema.

const ListInboxSchema = z.object({
  folder_id: z.string().max(100).optional().describe("Folder id; omit for the inbox root")
}).strict();

const LinkSupplierInvoiceSchema = z.object({
  file_id: z.string().min(1).describe("File id from upload_to_inbox or list_inbox"),
  given_number: z.string().min(1).describe("Supplier invoice löpnummer (GivenNumber)")
}).strict();

const LinkVoucherSchema = z.object({
  file_id: z.string().min(1).describe("File id from upload_to_inbox or list_inbox"),
  voucher_series: z.string().min(1).max(2),
  voucher_number: z.number().int().min(1),
  voucher_year: z.number().int().min(1).describe("Fortnox financial year ID (see fortnox_list_financial_years)")
}).strict();

const FileConnectionsSchema = z.object({
  given_number: z.string().min(1).optional().describe("Only connections for this supplier invoice"),
  voucher_series: z.string().max(2).optional(),
  voucher_number: z.number().int().min(1).optional(),
  voucher_year: z.number().int().min(1).optional()
}).strict();

const enc = encodeURIComponent;

/**
 * Map a path as a person or a Windows app would write it to one Node can open
 * on this machine. When the server runs in WSL, "C:\\Users\\x\\Downloads\\a.pdf"
 * becomes "/mnt/c/Users/x/Downloads/a.pdf". "~" and file:// URLs are expanded.
 */
export function resolveLocalPath(input: string, home: string = homedir(), platform: string = process.platform): string {
  let p = input.trim().replace(/^"(.*)"$/, "$1");
  if (p.startsWith("file://")) p = decodeURIComponent(p.slice("file://".length)).replace(/^\/([A-Za-z]:)/, "$1");
  if (p === "~" || p.startsWith("~/")) return join(home, p.slice(1));
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (win && platform !== "win32") return `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}`;
  return p;
}

/** Folders searched when a file is given by name only, newest match first. */
export async function uploadSearchDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<string[]> {
  if (env.FORTNOX_UPLOAD_DIRS) {
    return env.FORTNOX_UPLOAD_DIRS.split(";").map((d) => d.trim()).filter(Boolean).map((d) => resolveLocalPath(d, home));
  }
  const dirs = [join(home, "Downloads"), join(home, "Desktop")];
  // Every Windows drive WSL has mounted: Downloads is often moved off C:.
  let drives: string[] = [];
  try { drives = (await readdir("/mnt")).filter((d) => /^[a-z]$/.test(d)).sort(); } catch { /* not WSL */ }
  for (const drive of drives) {
    try {
      for (const e of await readdir(`/mnt/${drive}/Users`, { withFileTypes: true })) {
        const u = e.name;
        if (!e.isDirectory() || ["Public", "Default", "Default User", "All Users"].includes(u)) continue;
        dirs.push(`/mnt/${drive}/Users/${u}/Downloads`, `/mnt/${drive}/Users/${u}/Desktop`, `/mnt/${drive}/Users/${u}/OneDrive/Desktop`, `/mnt/${drive}/Users/${u}/OneDrive/Skrivbord`);
      }
    } catch { /* no Users folder on this drive */ }
  }
  return dirs;
}

/**
 * A bare file name ("faktura-123.pdf", as it shows on a chat attachment) is
 * looked up in the upload folders; the newest file with that name wins.
 * Anything with a directory part is used as given.
 */
/** A file name with brackets dropped, runs of spaces/underscores collapsed and case folded. */
export function looseName(name: string): string {
  return name.normalize("NFC").toLowerCase().replace(/[()[\]]/g, "").replace(/[\s_]+/g, " ").trim();
}

export async function findLocalFile(input: string, dirs?: string[]): Promise<string> {
  const p = resolveLocalPath(input);
  if (/[\\/]/.test(input.trim())) return p;
  let best: { path: string; mtime: number } | null = null;
  for (const d of dirs ?? await uploadSearchDirs()) {
    try {
      const st = await stat(join(d, p));
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: join(d, p), mtime: st.mtimeMs };
    } catch { /* not here */ }
  }
  if (!best) {
    // Chat attachments lose characters such as "(" and ")": "x (1).pdf" arrives as "x 1.pdf".
    const want = looseName(p);
    for (const d of dirs ?? await uploadSearchDirs()) {
      let names: string[] = [];
      try { names = await readdir(d); } catch { continue; }
      for (const n of names) {
        if (looseName(n) !== want) continue;
        let st;
        try { st = await stat(join(d, n)); } catch { continue; /* e.g. a broken symlink */ }
        if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: join(d, n), mtime: st.mtimeMs };
      }
    }
  }
  if (!best) throw new Error(`Found no file named "${input}" in ${(dirs ?? await uploadSearchDirs()).join(", ")}. Save it there or give the full path.`);
  return best.path;
}

type LinkTarget = z.infer<typeof LinkTargetSchema>;

/** Throws when a link target names neither or both kinds, or an incomplete voucher. */
export function checkLinkTarget(t: LinkTarget): "invoice" | "voucher" {
  const voucherParts = [t.voucher_series, t.voucher_number, t.voucher_year].filter((v) => v !== undefined).length;
  if (t.given_number && voucherParts) throw new Error("link_to takes either given_number or a voucher, not both.");
  if (t.given_number) return "invoice";
  if (voucherParts === 3) return "voucher";
  throw new Error("link_to needs given_number, or voucher_series + voucher_number + voucher_year.");
}

async function linkFile(fileId: string, t: LinkTarget): Promise<string> {
  if (checkLinkTarget(t) === "invoice") {
    await fortnoxRequest("/3/supplierinvoicefileconnections", "POST",
      { SupplierInvoiceFileConnection: { FileId: fileId, SupplierInvoiceNumber: t.given_number } });
    return `supplier invoice ${t.given_number}`;
  }
  await fortnoxRequest("/3/voucherfileconnections", "POST",
    { VoucherFileConnection: { FileId: fileId, VoucherSeries: t.voucher_series, VoucherNumber: String(t.voucher_number) } },
    { financialyear: t.voucher_year });
  return `voucher ${t.voucher_series}${t.voucher_number}`;
}

/** Throws unless the name has a PDF/image extension: only supporting documents are uploaded, never other files. */
export function checkUploadName(name: string): string {
  const type = MIME[extname(name).toLowerCase()];
  if (!type) {
    throw new Error(`Only PDF and image files can be uploaded (${Object.keys(MIME).join(", ")}): "${name}".`);
  }
  return type;
}

async function uploadOne(content: Buffer, name: string, folderId?: string) {
  const type = checkUploadName(name);
  const res = await fortnoxUpload<{ File: { Id: string; Name: string; Size?: number } }>(
    "/3/inbox", content, name, type, folderId ? { folderId } : undefined);
  return { file_id: res.File.Id, name: res.File.Name, size: res.File.Size ?? content.length };
}

export interface FileToolsOptions {
  /**
   * Whether tools may read files from this machine's disk. Only for the local (stdio) server:
   * on the shared remote server the disk is the server's, not the caller's, so path-based
   * upload would let any user upload server files to their own inbox.
   */
  allowLocalFiles?: boolean;
}

const RemoteUploadSchema = UploadSchema.omit({ file_path: true });

export function registerFileTools(server: McpServer, options: FileToolsOptions = {}): void {
  const allowLocalFiles = options.allowLocalFiles ?? false;

  server.registerTool("fortnox_upload_to_inbox", {
    title: "Upload File to Fortnox Inbox",
    description: allowLocalFiles
      ? `Upload a PDF or image (an invoice, receipt or statement) to the Fortnox inbox.
Prefer file_path: the server reads the file itself, so any size uploads in about a second.
A bare file name (e.g. the name of a file attached in the chat) is looked up in Downloads and Desktop
(or FORTNOX_UPLOAD_DIRS, ";"-separated) and the newest match is used, so never base64-encode a file
the user has on this computer: pass its name. The match ignores case, brackets and underscores, so check
source_path in the result: it names the file that was actually uploaded.
content_base64 is only for small files that exist nowhere on this machine.
Only .pdf, .png, .jpg, .jpeg, .gif, .tif and .tiff files are accepted.
Pass link_to to also attach it to a supplier invoice or a voucher in the same call.
For several files use fortnox_upload_files. Uploading alone books nothing.`
      : `Upload a PDF or image (an invoice, receipt or statement) to the Fortnox inbox, given as content_base64
with its file_name (.pdf, .png, .jpg, .jpeg, .gif, .tif or .tiff).
Pass link_to to also attach it to a supplier invoice or a voucher in the same call. Uploading alone books nothing.`,
    inputSchema: allowLocalFiles ? UploadSchema : RemoteUploadSchema,
    annotations: WRITE
  }, async (p: z.infer<typeof UploadSchema>) => {
    try {
      if (!allowLocalFiles && p.file_path) throw new Error("file_path is not available on this server; send content_base64.");
      if (!!p.file_path === !!p.content_base64) throw new Error("Provide exactly one of file_path or content_base64.");
      if (p.content_base64 && !p.file_name) throw new Error("file_name is required with content_base64.");
      if (p.link_to) checkLinkTarget(p.link_to);
      const path = p.file_path ? await findLocalFile(p.file_path) : undefined;
      const name = p.file_name || basename(path!);
      checkUploadName(name);
      if (path) checkUploadName(path);
      const content = path ? await readFile(path) : Buffer.from(p.content_base64!, "base64");
      const up = await uploadOne(content, name, p.folder_id);
      const source = path ? { source_path: path } : {};
      if (!p.link_to) return json({ success: true, uploaded: true, ...up, ...source, linked_to: null });
      try {
        const linked = await linkFile(up.file_id, p.link_to);
        return json({ success: true, uploaded: true, ...up, ...source, linked_to: linked });
      } catch (e) {
        // The upload stands: report its file_id so the file is linked, not uploaded again.
        return json({
          success: false, uploaded: true, ...up, ...source, linked_to: null,
          link_error: e instanceof Error ? e.message : String(e),
          hint: "The file is in the inbox. Link it with fortnox_link_file_to_supplier_invoice or fortnox_link_file_to_voucher using file_id; do not upload it again."
        });
      }
    } catch (e) { return buildErrorResponse(e); }
  });

  if (allowLocalFiles) server.registerTool("fortnox_upload_files", {
    title: "Upload Files to Fortnox Inbox (batch)",
    description: `Upload many PDFs/images from this machine to the Fortnox inbox in one call, each optionally
linked to a supplier invoice (given_number) or a voucher. Give either files (paths, Windows paths accepted)
or a directory (every .pdf/.jpg/.jpeg/.png/.gif/.tif/.tiff in it). One failing file does not stop the
others; the result lists each file's id, link or error. A file that uploaded but failed to link is
reported with uploaded: true and its file_id: link it with the link tools instead of uploading it again.
Uploading alone books nothing.`,
    inputSchema: UploadFilesSchema,
    annotations: WRITE
  }, async (p) => {
    try {
      if (!!p.files === !!p.directory) throw new Error("Provide exactly one of files or directory.");
      let items: Array<{ path: string; link_to?: LinkTarget }>;
      if (p.directory) {
        const dir = resolveLocalPath(p.directory);
        const names = (await readdir(dir)).filter((n) => MIME[extname(n).toLowerCase()]).sort();
        items = [];
        for (const n of names) {
          // An unreadable entry (e.g. a broken symlink) is skipped, not fatal for the batch.
          try { if ((await stat(join(dir, n))).isFile()) items.push({ path: join(dir, n) }); } catch { /* skip */ }
        }
        if (!items.length) throw new Error(`No PDF or image files in ${dir}.`);
      } else {
        items = p.files!.map((f) => ({ path: f.path, link_to: f.link_to }));
      }
      const results = [];
      for (const f of items) {
        let path = f.path;
        let up: Awaited<ReturnType<typeof uploadOne>> | null = null;
        try {
          if (f.link_to) checkLinkTarget(f.link_to);
          if (p.files) path = await findLocalFile(f.path);
          checkUploadName(path);
          up = await uploadOne(await readFile(path), basename(path), p.folder_id);
        } catch (e) {
          results.push({ path, ok: false, uploaded: false, error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        let linked: string | null = null;
        let link_error: string | null = null;
        if (f.link_to) {
          try { linked = await linkFile(up.file_id, f.link_to); }
          catch (e) { link_error = e instanceof Error ? e.message : String(e); }
        }
        results.push({ path, ok: !link_error, uploaded: true, ...up, linked_to: linked, error: link_error });
      }
      const uploaded = results.filter((r) => r.uploaded).length;
      const linkFailed = results.filter((r) => r.uploaded && !r.ok).length;
      return json({
        success: results.every((r) => r.ok),
        uploaded,
        failed: results.length - uploaded,
        link_failed: linkFailed,
        results
      });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_list_inbox", {
    title: "List Fortnox Inbox",
    description: "List files and folders in the Fortnox inbox (e.g. to find a file uploaded in the web UI and get its id).",
    inputSchema: ListInboxSchema,
    annotations: READ
  }, async ({ folder_id }) => {
    try {
      const endpoint = folder_id ? `/3/inbox/${enc(folder_id)}` : "/3/inbox";
      const res = await fortnoxRequest<{ Folder: {
        Id?: string; Name?: string;
        Files?: Array<{ Id: string; Name: string; Size?: number }>;
        Folders?: Array<{ Id: string; Name: string }>;
      } }>(endpoint);
      const f = res.Folder || {};
      return json({
        folder_id: f.Id ?? null,
        name: f.Name ?? null,
        folders: (f.Folders || []).map((x) => ({ id: x.Id, name: x.Name })),
        files: (f.Files || []).map((x) => ({ id: x.Id, name: x.Name, size: x.Size ?? null }))
      });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_link_file_to_supplier_invoice", {
    title: "Link File to Supplier Invoice",
    description: `Attach an uploaded file to a supplier invoice as its supporting document. Fortnox then shows it on
the invoice and on its booking and payment vouchers. Reversible: the connection can be removed in Fortnox.`,
    inputSchema: LinkSupplierInvoiceSchema,
    annotations: WRITE
  }, async ({ file_id, given_number }) => {
    try {
      const res = await fortnoxRequest<{ SupplierInvoiceFileConnection: { FileId: string; Name?: string; SupplierInvoiceNumber: string } }>(
        "/3/supplierinvoicefileconnections", "POST",
        { SupplierInvoiceFileConnection: { FileId: file_id, SupplierInvoiceNumber: given_number } });
      const c = res.SupplierInvoiceFileConnection;
      return json({ success: true, file_id: c.FileId, name: c.Name ?? null, given_number: c.SupplierInvoiceNumber });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_link_file_to_voucher", {
    title: "Link File to Voucher",
    description: "Attach an uploaded file to a voucher (e.g. a manual voucher for a bank fee) as its supporting document.",
    inputSchema: LinkVoucherSchema,
    annotations: WRITE
  }, async ({ file_id, voucher_series, voucher_number, voucher_year }) => {
    try {
      const res = await fortnoxRequest<{ VoucherFileConnection: { FileId: string; VoucherSeries: string; VoucherNumber: string; VoucherYear: number } }>(
        "/3/voucherfileconnections", "POST",
        // VoucherYear is read-only in the body (Fortnox rejects it); the year goes in the query.
        { VoucherFileConnection: { FileId: file_id, VoucherSeries: voucher_series, VoucherNumber: String(voucher_number) } },
        { financialyear: voucher_year });
      const c = res.VoucherFileConnection;
      return json({ success: true, file_id: c.FileId, voucher: `${c.VoucherSeries}${c.VoucherNumber}`, voucher_year: c.VoucherYear });
    } catch (e) { return buildErrorResponse(e); }
  });

  server.registerTool("fortnox_list_file_connections", {
    title: "List File Connections",
    description: "List which files are linked to supplier invoices (given_number) or vouchers (series/number/year).",
    inputSchema: FileConnectionsSchema,
    annotations: READ
  }, async (p) => {
    try {
      const out: Record<string, unknown> = {};
      const truncated: string[] = [];
      if (p.given_number || !p.voucher_series) {
        type R = { SupplierInvoiceFileConnections?: Array<{ FileId: string; Name?: string; SupplierInvoiceNumber: string }>; MetaInformation?: { "@TotalResources"?: number } };
        const r = await fetchAllPages<NonNullable<R["SupplierInvoiceFileConnections"]>[number], R>(
          "/3/supplierinvoicefileconnections",
          p.given_number ? { supplierinvoicenumber: p.given_number } : {},
          (x) => x.SupplierInvoiceFileConnections || [],
          (x) => x.MetaInformation?.["@TotalResources"] || 0);
        if (r.truncated) truncated.push(`supplier invoice connections: ${r.truncationReason}`);
        out.supplier_invoice_files = r.items
          .filter((c) => !p.given_number || c.SupplierInvoiceNumber === p.given_number)
          .map((c) => ({ file_id: c.FileId, name: c.Name ?? null, given_number: c.SupplierInvoiceNumber }));
      }
      if (p.voucher_series || !p.given_number) {
        type R = { VoucherFileConnections?: Array<{ FileId: string; VoucherSeries: string; VoucherNumber: string; VoucherYear: number; VoucherDescription?: string }>; MetaInformation?: { "@TotalResources"?: number } };
        const r = await fetchAllPages<NonNullable<R["VoucherFileConnections"]>[number], R>(
          "/3/voucherfileconnections",
          // Voucher endpoints default to the current financial year; ask for the one wanted.
          p.voucher_year ? { financialyear: p.voucher_year } : {},
          (x) => x.VoucherFileConnections || [],
          (x) => x.MetaInformation?.["@TotalResources"] || 0);
        if (r.truncated) truncated.push(`voucher connections: ${r.truncationReason}`);
        out.voucher_files = r.items
          .filter((c) => !p.voucher_series || c.VoucherSeries === p.voucher_series)
          .filter((c) => !p.voucher_number || Number(c.VoucherNumber) === p.voucher_number)
          .filter((c) => !p.voucher_year || c.VoucherYear === p.voucher_year)
          .map((c) => ({ file_id: c.FileId, voucher: `${c.VoucherSeries}${c.VoucherNumber}`, voucher_year: c.VoucherYear, description: c.VoucherDescription ?? null }));
      }
      if (truncated.length) {
        out.truncated = true;
        out.truncation_reason = `Not every connection was read, so a missing file may still be linked: ${truncated.join("; ")}`;
      }
      return json(out);
    } catch (e) { return buildErrorResponse(e); }
  });
}
