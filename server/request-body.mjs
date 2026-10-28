export const MAX_BODY_BYTES = 128 * 1024;
export const BODY_TIMEOUT_MS = 10_000;

export class RequestBodyError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}

export function checkedBody(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (body.length > MAX_BODY_BYTES) throw new RequestBodyError(413, "Request body is too large");
  return body;
}

export async function readRequestBody(req, { timeoutMs = BODY_TIMEOUT_MS, allowParsed = true } = {}) {
  // Vercel adds a lazy JSON-parsing getter. Reading it would change signed bytes.
  // Only explicit data properties are already-parsed bodies owned by our caller.
  const bodyProperty = Object.getOwnPropertyDescriptor(req, "body");
  if (allowParsed && bodyProperty && "value" in bodyProperty && bodyProperty.value !== undefined) {
    const supplied = bodyProperty.value;
    try {
      return checkedBody(typeof supplied === "object" && !Buffer.isBuffer(supplied)
        ? JSON.stringify(supplied) : supplied);
    } catch (error) {
      if (error instanceof RequestBodyError) throw error;
      throw new RequestBodyError(400, "Invalid request body");
    }
  }
  const length = req.headers?.["content-length"];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_BODY_BYTES)) {
    throw new RequestBodyError(413, "Request body is too large");
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error) => {
      cleanup();
      // A peer reset can emit an error immediately after the aborted event.
      req.once("error", () => {});
      req.pause();
      reject(error);
    };
    const onData = (chunk) => {
      const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += body.length;
      if (size > MAX_BODY_BYTES) return fail(new RequestBodyError(413, "Request body is too large"));
      chunks.push(body);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const onError = () => fail(new RequestBodyError(400, "Could not read request body"));
    const onAborted = () => fail(new RequestBodyError(400, "Request body was interrupted"));
    const timer = setTimeout(() => fail(new RequestBodyError(408, "Request body timed out")), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

export async function readJsonBody(req, options) {
  const raw = await readRequestBody(req, options);
  if (!raw.length) return {};
  try {
    const body = JSON.parse(raw.toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new RequestBodyError(400, "Invalid JSON body");
  }
}

export function sendBodyError(res, error) {
  if (!(error instanceof RequestBodyError)) return false;
  res.setHeader("Connection", "close");
  res.status(error.status).json({ error: error.message });
  return true;
}
