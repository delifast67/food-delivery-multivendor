import express, { Request, Response, NextFunction } from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express4";
import { GraphQLError, ValidationContext, ASTNode, Kind } from "graphql";
import { readFile } from "node:fs/promises";
import { connect, getDb } from "./db.js";
import { config } from "./config.js";
import { normalizeAddress, normalizeCart } from "./validation.js";
import { PaymentService, type CheckoutGateway } from "./payment-service.js";
import { createPaymentGateway } from "./payment-gateway.js";
import { calculateCheckout } from "./pricing.js";
import {
  placeOrder,
  customerOrder,
  operationsOrders,
  availableRiders,
  transition,
  simulatePayment,
  assign,
} from "./orders.js";
import { authenticate, login, logout, requireRole } from "./auth.js";
import {
  publicRestaurants,
  publicRestaurant,
  operationsRestaurants,
  menuFor,
  categoriesFor,
  createMenuCategory,
  updateMenuCategory,
  setMenuCategoryArchived,
  createMenuItem,
  updateMenuItem,
  setMenuItemArchived,
  setRestaurantOpen,
} from "./catalog.js";
const typeDefs = await readFile(
  new URL("../schema/v1.graphql", import.meta.url),
  "utf8",
);
const knownCodes = new Set([
  "INVALID_INPUT",
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
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "PAYMENT_DISABLED",
  "PAYMENT_REQUIRED",
  "INVALID_TRANSITION",
  "ORDER_NOT_FOUND",
  "RIDER_NOT_FOUND",
  "CONCURRENT_MODIFICATION",
  "INVALID_OPTIONS",
  "CATEGORY_NOT_FOUND",
  "PAYMENT_IN_PROGRESS",
  "PAYMENT_REVIEW_REQUIRED",
  "PAYMENT_NOT_ALLOWED",
  "PAYMENT_UNAVAILABLE",
]);
function complexityRule(context: ValidationContext) {
  let depth = 0,
    fields = 0,
    aliases = 0,
    operations = 0;
  const enter = (node: ASTNode) => {
    if (node.kind === Kind.OPERATION_DEFINITION && ++operations > 1)
      context.reportError(
        new GraphQLError("Une seule opération est autorisée", {
          extensions: { code: "QUERY_TOO_COMPLEX" },
        }),
      );
    if (node.kind === Kind.FIELD) {
      depth++;
      fields++;
      if (fields > 100 || depth > 10 || (node.alias && ++aliases > 100))
        context.reportError(
          new GraphQLError("Requête trop complexe", {
            extensions: { code: "QUERY_TOO_COMPLEX" },
          }),
        );
    }
  };
  const leave = (node: ASTNode) => {
    if (node.kind === Kind.FIELD) depth--;
  };
  return { Field: { enter, leave }, OperationDefinition: { enter, leave } };
}
function rateLimit() {
  const buckets = new Map<string, { start: number; count: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || "unknown",
      now = Date.now(),
      c = buckets.get(key);
    if (!c || now - c.start >= config.rateLimitWindowMs)
      buckets.set(key, { start: now, count: 1 });
    else if (++c.count > config.rateLimitMax) {
      res.status(429).json({
        errors: [
          {
            message: "Trop de requêtes",
            extensions: { code: "RATE_LIMITED" },
          },
        ],
      });
      return;
    }
    next();
  };
}
const resolvers: any = {
  Query: {
    restaurants: () => publicRestaurants(getDb()),
    restaurant: (_: any, { id }: any) => publicRestaurant(getDb(), id),
    operationsRestaurants: (_: any, _a: any, ctx: any) =>
      operationsRestaurants(getDb(), requireRole(ctx, ["ADMIN", "RESTAURANT"])),
    calculateCheckout: (_: any, { input }: any) =>
      calculateCheckout(getDb(), normalizeCart(input)),
    order: (_: any, { id, accessToken }: any) =>
      customerOrder(getDb(), id, accessToken),
    paymentSession: (_: any, { orderId, accessToken }: any, ctx: any) =>
      ctx.payments.getSession(orderId, accessToken),
    operationsOrders: (_: any, _a: any, ctx: any) =>
      operationsOrders(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT", "RIDER"]),
      ),
    availableRiders: (_: any, _a: any, ctx: any) =>
      availableRiders(getDb(), requireRole(ctx, ["ADMIN"])),
    me: (_: any, _a: any, ctx: any) => ctx.user || null,
  },
  Restaurant: {
    menu: (r: any) => menuFor(getDb(), r),
    categories: (r: any) => categoriesFor(getDb(), r),
  },
  CheckoutItem: {
    baseUnitPrice: (x: any) => x.baseUnitPrice ?? x.unitPrice,
    selectedOptions: (x: any) =>
      Array.isArray(x.selectedOptions) ? x.selectedOptions : [],
  },
  MenuItem: {
    optionGroups: (x: any) =>
      Array.isArray(x.optionGroups) ? x.optionGroups : [],
  },
  Mutation: {
    placeOrder: (_: any, { input }: any) =>
      placeOrder(
        getDb(),
        normalizeCart(input),
        normalizeAddress(input.deliveryAddress),
        input.idempotencyKey,
      ),
    startPayment: (_: any, { input }: any, ctx: any) =>
      ctx.payments.start(input),
    refreshPayment: (_: any, { orderId, accessToken }: any, ctx: any) =>
      ctx.payments.refresh(orderId, accessToken),
    staffLogin: (_: any, { email, password }: any) =>
      login(getDb(), email, password),
    staffLogout: (_: any, _a: any, ctx: any) => logout(getDb(), ctx),
    simulateDemoPayment: (_: any, { orderId }: any, ctx: any) =>
      simulatePayment(getDb(), requireRole(ctx, ["ADMIN"]), orderId),
    transitionOrder: (
      _: any,
      { orderId, status, expectedStatus }: any,
      ctx: any,
    ) =>
      transition(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT", "RIDER"]),
        orderId,
        status,
        expectedStatus,
      ),
    assignRider: (
      _: any,
      { orderId, riderId, expectedStatus }: any,
      ctx: any,
    ) =>
      assign(
        getDb(),
        requireRole(ctx, ["ADMIN"]),
        orderId,
        riderId,
        expectedStatus,
      ),
    createMenuItem: (_: any, { restaurantId, input }: any, ctx: any) =>
      createMenuItem(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT"]),
        restaurantId,
        input,
      ),
    updateMenuItem: (_: any, { id, expectedVersion, input }: any, ctx: any) =>
      updateMenuItem(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT"]),
        id,
        expectedVersion,
        input,
      ),
    setMenuItemArchived: (
      _: any,
      { id, expectedVersion, archived }: any,
      ctx: any,
    ) =>
      setMenuItemArchived(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT"]),
        id,
        expectedVersion,
        archived,
      ),
    setRestaurantOpen: (_: any, { id, expectedVersion, open }: any, ctx: any) =>
      setRestaurantOpen(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT"]),
        id,
        expectedVersion,
        open,
      ),
    createMenuCategory: (_: any, { restaurantId, input }: any, ctx: any) =>
      createMenuCategory(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT"]),
        restaurantId,
        input,
      ),
    updateMenuCategory: (
      _: any,
      { id, expectedVersion, input }: any,
      ctx: any,
    ) =>
      updateMenuCategory(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT"]),
        id,
        expectedVersion,
        input,
      ),
    setMenuCategoryArchived: (
      _: any,
      { id, expectedVersion, archived }: any,
      ctx: any,
    ) =>
      setMenuCategoryArchived(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT"]),
        id,
        expectedVersion,
        archived,
      ),
  },
};
export async function createApp(
  gateway: CheckoutGateway | undefined = createPaymentGateway(),
) {
  await connect();
  const payments = new PaymentService(getDb(), gateway);
  const apollo = new ApolloServer({
    typeDefs,
    resolvers,
    csrfPrevention: true,
    validationRules: [complexityRule],
    formatError: (f: any) => {
      const complex = /complex|opération|operation|only be the only/i.test(
        String(f.message),
      );
      const invalidVariables = f.extensions?.code === "BAD_USER_INPUT";
      const code = invalidVariables
        ? "INVALID_INPUT"
        : complex
          ? "QUERY_TOO_COMPLEX"
          : typeof f.extensions?.code === "string" &&
              knownCodes.has(f.extensions.code)
            ? f.extensions.code
            : f.extensions?.code === "GRAPHQL_VALIDATION_FAILED"
              ? f.extensions.code
              : "INTERNAL_ERROR";
      return {
        message: invalidVariables
          ? "Entrées invalides"
          : code === "INTERNAL_ERROR"
            ? "Erreur interne"
            : f.message,
        extensions: { code },
      };
    },
  });
  await apollo.start();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.maxBody }));
  const ipnParserOptions = {
    extended: true,
    limit: 16_384,
    parameterLimit: 100,
    depth: 6,
  };
  app.post(
    "/payments/paydunya/ipn",
    rateLimit(),
    (req, res, next) => {
      if (!req.is("application/x-www-form-urlencoded")) {
        res.status(415).json({ error: "INVALID_IPN" });
        return;
      }
      next();
    },
    express.urlencoded(ipnParserOptions),
    async (req, res) => {
      try {
        await payments.ipn(req.body?.data);
        res.status(200).json({ received: true });
      } catch (error: any) {
        const code = error?.extensions?.code;
        const status = code === "INVALID_IPN" ? 400 : 503;
        res
          .status(status)
          .json({
            error: status === 400 ? "INVALID_IPN" : "PAYMENT_UNAVAILABLE",
          });
      }
    },
  );
  app.get("/health", async (_req, res) => {
    try {
      await getDb().command({ ping: 1 });
      res.json({ status: "ok", service: "delifast-api" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use(
    "/graphql",
    rateLimit(),
    expressMiddleware(apollo, {
      context: async ({ req }) => ({
        ...(await authenticate(getDb(), req.headers.authorization)),
        payments,
      }),
    }),
  );
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res
      .status(error?.status === 413 ? 413 : 400)
      .json({ error: "INVALID_INPUT" });
  });
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
