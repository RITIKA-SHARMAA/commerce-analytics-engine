import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { logger } from "./logger";

export class AppError extends Error {
  constructor(public statusCode: number, message: string, public code = "APP_ERROR") {
    super(message);
    this.name = "AppError";
  }
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid request", details: err.issues.map(i => ({ path: i.path.join("."), message: i.message })) } });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }
  logger.error({ err, path: req.path }, "unhandled request error");
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
};

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
export const asyncRoute = (fn: AsyncHandler): RequestHandler => (req, res, next) => {
  fn(req, res, next).catch(next);
};
