import type { Response } from "express";

/**
 * Every failure this API returns has the same shape:
 *
 *     { "error": { "code": "customer_exists", "message": "...", "hint": "..." } }
 *
 * `code` is the stable machine-readable discriminator the browser branches
 * on, `message` is safe to render to a person, and `hint` is the optional
 * next step. Driver exceptions, stack traces and SQL strings never reach a
 * client: they are logged server-side and reported as `internal_error`.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    hint?: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  body(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (code: string, message: string, hint?: string) =>
  new ApiError(400, code, message, hint);

export const notFound = (code: string, message: string) =>
  new ApiError(404, code, message);

export const conflict = (
  code: string,
  message: string,
  hint?: string,
  details?: Record<string, unknown>,
) => new ApiError(409, code, message, hint, details);

/**
 * Turn anything thrown on a request path into a client-safe response.
 * Known failures keep their code; everything else is logged in full and
 * reported as a generic internal error so no driver text leaks.
 */
export function sendError(res: Response, error: unknown, context: string) {
  if (error instanceof ApiError) {
    return res.status(error.status).json(error.body());
  }
  console.error(`[${context}]`, error);
  const body: ApiErrorBody = {
    error: {
      code: "internal_error",
      message: "Something went wrong on our side. Please try again.",
      hint: `Check the server log for the ${context} failure.`,
    },
  };
  return res.status(500).json(body);
}

/**
 * The LangWatch REST calls sit between this app and its customers, so a
 * failure there is reported as an upstream problem with the operation that
 * failed, never as the SDK's raw error text.
 */
export function upstreamError(operation: string, error: unknown): ApiError {
  console.error(`[langwatch:${operation}]`, error);
  return new ApiError(
    502,
    "langwatch_unavailable",
    `The billing platform could not complete "${operation}".`,
    "Confirm LANGWATCH_BASE_URL and LANGWATCH_API_KEY, then retry.",
  );
}

/** True when better-sqlite3 raised a UNIQUE violation on the given column. */
export function isUniqueViolation(error: unknown, column: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") && message.includes(column);
}
