import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

export const requestIdMiddleware = (request: Request, response: Response, next: NextFunction) => {
  const requestId = request.header("x-request-id") ?? randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);
  next();
};
