import express, { Request, Response, NextFunction } from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express4";
import {
  GraphQLError,
  ValidationContext,
  ASTNode,
  Kind,
  DocumentNode,
} from "graphql";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import { connect, getDb } from "./db.js";
import { config } from "./config.js";
import { normalizeAddress, normalizeCart, fail } from "./validation.js";
import { calculateCheckout } from "./pricing.js";
import { placeOrder } from "./orders.js";

const typeDefs = await readFile(
  new URL("../schema/v1.graphql", import.meta.url),
  "utf8",
);
const knownCodes = new Set([
  "INVALID_CART",
  "INVALID_QUANTITY",
  "INVALID_INPUT",
  "RESTAURANT_NOT_FOUND",
  "RESTAURANT_CLOSED",
  "ITEM_NOT_FOUND",
  "ITEM_RESTAURANT_MISMATCH",
  "ITEM_UNAVAILABLE",
  "INVALID_PRICE",
  "AMOUNT_OVERFLOW",
  "OUT_OF_DEMO_ZONE",
  "INVALID_PHONE",
  "INVALID_ADDRESS",
  "INVALID_IDEMPOTENCY_KEY",
  "IDEMPOTENCY_CONFLICT",
]);

function complexityRule(context: ValidationContext) {
  let depth = 0;
  let aliases = 0;
  let fields = 0;
  let operations = 0;
  const enter = (node: ASTNode) => {
    if (node.kind === Kind.OPERATION_DEFINITION) {
      operations++;
      if (operations > 1)
        context.reportError(
          new GraphQLError("Une seule opération est autorisée", {
            extensions: { code: "QUERY_TOO_COMPLEX" },
          }),
        );
    }
    if (node.kind === Kind.FIELD) {
      depth++;
      fields++;
      if (fields > 100)
        context.reportError(
          new GraphQLError("Trop de champs", {
            extensions: { code: "QUERY_TOO_COMPLEX" },
          }),
        );
      if (node.alias) aliases++;
      if (aliases > 100)
        context.reportError(
          new GraphQLError("Trop d’alias", {
            extensions: { code: "QUERY_TOO_COMPLEX" },
          }),
        );
      if (depth > 10)
        context.reportError(
          new GraphQLError("Requête trop profonde", {
            extensions: { code: "QUERY_TOO_COMPLEX" },
          }),
        );
    }
  };
  const leave = (node: ASTNode) => {
    if (node.kind === Kind.FIELD) depth--;
  };
  return {
    Field: { enter, leave },
    OperationDefinition: {
      enter(node: any) {
        enter(node);
      },
      leave,
    },
  };
}

function rateLimit() {
  const buckets = new Map<string, { start: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || now - current.start >= config.rateLimitWindowMs)
      buckets.set(key, { start: now, count: 1 });
    else {
      current.count++;
      if (current.count > config.rateLimitMax) {
        res
          .status(429)
          .json({
            errors: [
              {
                message: "Trop de requêtes",
                extensions: { code: "RATE_LIMITED" },
              },
            ],
          });
        return;
      }
    }
    if (buckets.size > 10_000)
      for (const [k, value] of buckets)
        if (now - value.start >= config.rateLimitWindowMs) buckets.delete(k);
    next();
  };
}

const resolvers = {
  Query: {
    restaurants: () => getDb().collection("restaurants").find({}).toArray(),
    restaurant: (_: unknown, { id }: { id: string }) =>
      getDb().collection("restaurants").findOne({ id }),
    calculateCheckout: (_: unknown, { input }: { input: unknown }) =>
      calculateCheckout(getDb(), normalizeCart(input)),
    order: (
      _: unknown,
      { id, accessToken }: { id: string; accessToken: string },
    ) => getDb().collection("orders").findOne({ id, accessToken }),
  },
  Restaurant: {
    menu: (restaurant: { id: string }) =>
      getDb()
        .collection("menu_items")
        .find({ restaurantId: restaurant.id })
        .toArray(),
  },
  Mutation: {
    placeOrder: (_: unknown, { input }: { input: any }) =>
      placeOrder(
        getDb(),
        normalizeCart(input),
        normalizeAddress(input.deliveryAddress),
        input.idempotencyKey,
      ),
  },
};

export async function createApp() {
  await connect();
  const apollo = new ApolloServer({
    typeDefs,
    resolvers,
    csrfPrevention: true,
    validationRules: [complexityRule],
    formatError: (formatted: any) => {
      const code =
        formatted.message?.includes("opération") ||
        formatted.message?.includes("alias") ||
        formatted.message?.includes("profonde") ||
        formatted.message?.includes("champs")
          ? "QUERY_TOO_COMPLEX"
          : typeof formatted.extensions?.code === "string" &&
              knownCodes.has(formatted.extensions.code)
            ? formatted.extensions.code
            : formatted.extensions?.code === "GRAPHQL_VALIDATION_FAILED"
              ? formatted.extensions.code
              : "INTERNAL_ERROR";
      return {
        message:
          code === "INTERNAL_ERROR" ? "Erreur interne" : formatted.message,
        extensions: { code },
      };
    },
  });
  await apollo.start();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.maxBody }));
  app.get("/health", async (_req, res) => {
    try {
      await getDb().command({ ping: 1 });
      res.json({ status: "ok", service: "delifast-api" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use("/graphql", rateLimit(), expressMiddleware(apollo));
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = await createApp();
  const server = app.listen(config.port, config.host, () =>
    console.log(`Delifast API écoute sur ${config.host}:${config.port}`),
  );
  const shutdown = async () => {
    server.close();
    const { closeDb } = await import("./db.js");
    await closeDb();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
