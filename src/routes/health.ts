import type { FastifyInstance } from "fastify";

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_request, reply) => {
    reply.code(200).send({ ok: true, service: "wave-signal-gateway" });
  });
}
