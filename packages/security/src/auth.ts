import type { FastifyReply, FastifyRequest } from "fastify";

export async function requireApiToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env.API_TOKEN;
  if (process.env.AUTH_DISABLED === "true") {
    return;
  }
  if (!expected) {
    await reply.code(401).send({ error: "unauthorized", code: "API_TOKEN_REQUIRED" });
    return;
  }
  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${expected}`) {
    await reply.code(401).send({ error: "unauthorized" });
  }
}
