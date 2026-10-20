import { createSmsProvider, type SmsProvider } from "./sms-provider.js";
import express, { Request, Response, NextFunction } from "express";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express4";
import { complexityRule } from "./graphql-complexity.js";
import { readFile } from "node:fs/promises";
import { connect, getDb } from "./db.js";
import { config } from "./config.js";
import { normalizeAddress, normalizeCart } from "./validation.js";
import { PaymentService, type CheckoutGateway } from "./payment-service.js";
import { createPaymentGateway, createPaymentConfiguration } from "./payment-gateway.js";
import { calculateCheckout } from "./pricing.js";
import {
  placeOrder,
  customerOrder,
  customerOrders,
  customerOrderByCustomer,
  operationsOrders,
  operationsOrdersPage,
  operationsOrder,
  availableRiders,
  operationsRiderSummaries,
  operationsRider,
  transition,
  simulatePayment,
  assign,
} from "./orders.js";
import { authenticate, login, logout, requireRole } from "./auth.js";
import { authenticateCustomer } from "./customer-auth.js";
import { requestOtp, resendOtp, verifyOtp, customerLogout, listAddresses, createAddress, updateAddress, deleteAddress, requireCustomer, updateCustomerProfile } from "./customer-auth.js";
import { createSupportTicket, createStaffSupportTicket, customerSupportTickets, customerSupportTicket, staffSupportTickets, staffSupportTicket, operationsSupportTickets, operationsSupportTicket, operationsSupportTicketSummaries, transitionSupportTicket } from "./support.js";
import {
  publicRestaurants,
  publicRestaurant,
  operationsRestaurants,
  operationsRestaurantSummaries,
  operationsRestaurant,
  operationsMenuItemSummaries,
  operationsMenuItem,
  operationsMenuCategorySummaries,
  operationsMenuCategory,
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
import { normalizePoint, eligibility, listDeliveryZones, createDeliveryZone, updateDeliveryZone } from "./zones.js";
import { createRestaurantProfile, updateRestaurantProfile, restaurantZoneIds } from "./restaurant.js";
import { setRestaurantSchedule } from "./restaurant.js";
import { isRestaurantOpen } from "./restaurant-hours.js";
const typeDefs = await readFile(
  new URL("../schema/v1.graphql", import.meta.url),
  "utf8",
);
const knownCodes = new Set([
  "INVALID_POINT",
  "INVALID_ZONE",
  "ZONE_NOT_FOUND",
  "DELIVERY_POINT_REQUIRED",
  "OUT_OF_DELIVERY_ZONE",
  "MINIMUM_ORDER_NOT_MET",
  "INVALID_INPUT",
  "INVALID_CART",
  "INVALID_CURSOR",
  "RESTAURANT_NOT_FOUND",
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
  "ZONE_NOT_FOUND",
  "AUTH_UNAVAILABLE",
  "RATE_LIMITED",
  "CHALLENGE_ACTIVE",
  "INVALID_CHALLENGE",
  "OTP_REJECTED",
  "CONCURRENT_REQUEST",
  "ADDRESS_NOT_FOUND",
  "DELIVERY_POINT_REQUIRED",
  "SUPPORT_TICKET_NOT_FOUND",
  "CUSTOMER_PROFILE_REQUIRED",
]);
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
    restaurants: async (_: any, { point }: any) => {
      const restaurants = await publicRestaurants(getDb());
      if (point == null) return restaurants;
      const location = normalizePoint(point);
      const matches = await Promise.all(restaurants.map(async (r: any) => {
        if (!isRestaurantOpen(r)) return null;
        try { await eligibility(getDb(), r.id, location); return r; }
        catch (error: any) {
          if (["OUT_OF_DELIVERY_ZONE"].includes(error?.extensions?.code)) return null;
          throw error;
        }
      }));
      return matches.filter(Boolean);
    },
    deliveryEligibility: (_: any, { restaurantId, point }: any) => eligibility(getDb(), restaurantId, normalizePoint(point)),
    deliveryZones: (_: any, { restaurantId }: any, ctx: any) => listDeliveryZones(getDb(), requireRole(ctx, ["ADMIN", "RESTAURANT"]), restaurantId),
    restaurant: (_: any, { id }: any) => publicRestaurant(getDb(), id),
    operationsRestaurants: (_: any, _a: any, ctx: any) =>
      operationsRestaurants(getDb(), requireRole(ctx, ["ADMIN", "RESTAURANT"])),
    operationsRestaurantSummaries: (_: any, { limit, after, restaurantId }: any, ctx: any) => {
      requireRole(ctx, ["ADMIN"]);
      return operationsRestaurantSummaries(getDb(), limit, after, restaurantId);
    },
    operationsRestaurant: (_: any, { id }: any, ctx: any) => {
      requireRole(ctx, ["ADMIN"]);
      return operationsRestaurant(getDb(), id);
    },
    operationsMenuItemSummaries: (_: any, { restaurantId, limit, after, menuItemId }: any, ctx: any) =>
      operationsMenuItemSummaries(
        getDb(),
        requireRole(ctx, ["ADMIN"]),
        restaurantId,
        limit,
        after,
        menuItemId,
      ),
    operationsMenuItem: (_: any, { restaurantId, id }: any, ctx: any) =>
      operationsMenuItem(getDb(), requireRole(ctx, ["ADMIN"]), restaurantId, id),
    operationsMenuCategorySummaries: (_: any, { restaurantId, limit, after, categoryId }: any, ctx: any) =>
      operationsMenuCategorySummaries(getDb(), requireRole(ctx, ["ADMIN"]), restaurantId, limit, after, categoryId),
    operationsMenuCategory: (_: any, { restaurantId, id }: any, ctx: any) =>
      operationsMenuCategory(getDb(), requireRole(ctx, ["ADMIN"]), restaurantId, id),
    calculateCheckout: (_: any, { input }: any) =>
      calculateCheckout(getDb(), normalizeCart(input)),
    order: (_: any, { id, accessToken }: any) =>
      customerOrder(getDb(), id, accessToken),
    customerOrders: (_: any, { limit, after }: any, ctx: any) =>
      customerOrders(getDb(), requireCustomer(ctx).id, limit, after),
    customerOrder: (_: any, { id }: any, ctx: any) =>
      customerOrderByCustomer(getDb(), requireCustomer(ctx).id, id),
    paymentSession: (_: any, { orderId, accessToken }: any, ctx: any) =>
      ctx.payments.getSession(orderId, accessToken),
    operationsOrders: (_: any, _a: any, ctx: any) =>
      operationsOrders(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT", "RIDER"]),
      ),
    operationsOrdersPage: (_: any, args: any, ctx: any) => {
      const user = requireRole(ctx, ["ADMIN", "RESTAURANT", "RIDER"]);
      return operationsOrdersPage(getDb(), user, args.limit, args.after, args.status, args.payment, args.restaurantId, args.search);
    },
    operationsOrder: (_: any, { id }: any, ctx: any) =>
      operationsOrder(getDb(), requireRole(ctx, ["ADMIN", "RESTAURANT", "RIDER"]), id),
    availableRiders: (_: any, _a: any, ctx: any) =>
      availableRiders(getDb(), requireRole(ctx, ["ADMIN"])),
    operationsRiderSummaries: (_: any, { limit, after, riderId }: any, ctx: any) =>
      operationsRiderSummaries(getDb(), requireRole(ctx, ["ADMIN"]), limit, after, riderId),
    operationsRider: (_: any, { id }: any, ctx: any) =>
      operationsRider(getDb(), requireRole(ctx, ["ADMIN"]), id),
    me: (_: any, _a: any, ctx: any) => ctx.user || null,
    customerMe: (_: any, _a: any, ctx: any) => ctx.customer || null,
    customerAddresses: (_: any, _a: any, ctx: any) => listAddresses(getDb(), ctx),
    customerSupportTickets: (_: any, { limit, offset }: any, ctx: any) => customerSupportTickets(getDb(), ctx, limit, offset),
    customerSupportTicket: (_: any, { id }: any, ctx: any) => customerSupportTicket(getDb(), ctx, id),
    staffSupportTickets: (_: any, { limit, offset }: any, ctx: any) => staffSupportTickets(getDb(), requireRole(ctx, ["RESTAURANT", "RIDER"]), limit, offset),
    staffSupportTicket: (_: any, { id }: any, ctx: any) => staffSupportTicket(getDb(), requireRole(ctx, ["RESTAURANT", "RIDER"]), id),
    operationsSupportTickets: (_: any, { limit, offset }: any, ctx: any) => operationsSupportTickets(getDb(), requireRole(ctx, ["ADMIN"]), limit, offset),
    operationsSupportTicket: (_: any, { id }: any, ctx: any) => operationsSupportTicket(getDb(), requireRole(ctx, ["ADMIN"]), id),
    operationsSupportTicketSummaries: (_: any, { limit, offset, ticketId, status }: any, ctx: any) => operationsSupportTicketSummaries(getDb(), requireRole(ctx, ["ADMIN"]), limit, offset, ticketId, status),
  },
  Restaurant: {
    deliveryZoneIds: (r: any) => restaurantZoneIds(getDb(), r),
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
    createDeliveryZone: (_: any, { restaurantId, input }: any, ctx: any) => createDeliveryZone(getDb(), requireRole(ctx, ["ADMIN"]), restaurantId, input),
    updateDeliveryZone: (_: any, { id, expectedVersion, input }: any, ctx: any) => updateDeliveryZone(getDb(), requireRole(ctx, ["ADMIN"]), id, expectedVersion, input),
    placeOrder: (_: any, { input }: any, ctx: any) => {
      if (ctx.customerAuthPresented && !ctx.customer) requireCustomer(ctx);
      return placeOrder(
        getDb(),
        normalizeCart(input),
        normalizeAddress(input.deliveryAddress),
        input.idempotencyKey,
        ctx.customer?.id,
      );
    },
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
      { orderId, status, expectedStatus, expectedUpdatedAt }: any,
      ctx: any,
    ) =>
      transition(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT", "RIDER"]),
        orderId,
        status,
        expectedStatus,
        expectedUpdatedAt,
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
    createRestaurantProfile: (_: any, { input }: any, ctx: any) => createRestaurantProfile(getDb(), requireRole(ctx, ["ADMIN"]), input),
    updateRestaurantProfile: (_: any, { id, expectedVersion, input }: any, ctx: any) => updateRestaurantProfile(getDb(), requireRole(ctx, ["ADMIN"]), id, expectedVersion, input),
    setRestaurantOpen: (_: any, { id, expectedVersion, open }: any, ctx: any) =>
      setRestaurantOpen(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT"]),
        id,
        expectedVersion,
        open,
      ),
    setRestaurantSchedule: (_: any, { id, expectedVersion, weeklySchedule }: any, ctx: any) =>
      setRestaurantSchedule(
        getDb(),
        requireRole(ctx, ["ADMIN", "RESTAURANT"]),
        id,
        expectedVersion,
        weeklySchedule,
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
    requestCustomerOtp: (_: any, { phone }: any, ctx: any) => requestOtp(getDb(), ctx.otpProvider, phone, ctx.peerIp),
    resendCustomerOtp: (_: any, { challengeId }: any, ctx: any) => resendOtp(getDb(), ctx.otpProvider, challengeId, ctx.peerIp),
    verifyCustomerOtp: (_: any, { challengeId, code }: any, ctx: any) => verifyOtp(getDb(), ctx.otpProvider, challengeId, code),
    updateCustomerProfile: (_: any, { input }: any, ctx: any) => updateCustomerProfile(getDb(), ctx, input),
    customerLogout: (_: any, _a: any, ctx: any) => customerLogout(getDb(), ctx),
    createCustomerAddress: (_: any, { input }: any, ctx: any) => createAddress(getDb(), ctx, input),
    updateCustomerAddress: (_: any, { id, input }: any, ctx: any) => updateAddress(getDb(), ctx, id, input),
    deleteCustomerAddress: (_: any, { id }: any, ctx: any) => deleteAddress(getDb(), ctx, id),
    createSupportTicket: (_: any, { input }: any, ctx: any) => createSupportTicket(getDb(), ctx, input),
    createStaffSupportTicket: (_: any, { input }: any, ctx: any) => createStaffSupportTicket(getDb(), requireRole(ctx, ["RESTAURANT", "RIDER"]), input),
    transitionSupportTicket: (_: any, { id, expectedVersion, status, note }: any, ctx: any) => transitionSupportTicket(getDb(), requireRole(ctx, ["ADMIN"]), id, expectedVersion, status, note),
  },
};
export async function createApp(
  gateway: CheckoutGateway | undefined = createPaymentGateway(),
  otpProvider: SmsProvider = createSmsProvider(),
  reconciliationProviders: readonly CheckoutGateway[] = createPaymentConfiguration().reconciliationProviders,
) {
  await connect();
  const payments = new PaymentService(getDb(), gateway, reconciliationProviders);
  const apollo = new ApolloServer({
    typeDefs,
    resolvers,
    csrfPrevention: true,
    validationRules: [complexityRule],
    formatError: (f: any, error: any) => {
      // Apollo wraps validation errors and replaces their public extension code.
      const complex = f.extensions?.code === "QUERY_TOO_COMPLEX" ||
        error?.originalError?.extensions?.code === "QUERY_TOO_COMPLEX";
      const invalidVariables = f.extensions?.code === "BAD_USER_INPUT";
      const invalidDocument = f.extensions?.code === "GRAPHQL_VALIDATION_FAILED";
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
        // GraphQL validation messages can embed inline OTPs or other input values.
        // Classify by extension code, never by attacker-controlled message text.
        message: complex
          ? "Requête trop complexe"
          : invalidVariables || invalidDocument
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
  app.post(
    "/payments/cinetpay/ipn",
    rateLimit(),
    (req, res, next) => {
      if (!req.is("application/json")) {
        res.status(415).json({ error: "INVALID_IPN" });
        return;
      }
      next();
    },
    express.json({ limit: 16_384, strict: true }),
    async (req, res) => {
      try {
        await payments.notification("cinetpay", req.body);
        res.status(200).json({ received: true });
      } catch (error: any) {
        const status = error?.extensions?.code === "INVALID_IPN" ? 400 : 503;
        res.status(status).json({ error: status === 400 ? "INVALID_IPN" : "PAYMENT_UNAVAILABLE" });
      }
    },
  );
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
        await payments.notification("paydunya", req.body?.data);
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
    (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store, private");
      next();
    },
    rateLimit(),
    expressMiddleware(apollo, {
      context: async ({ req }) => ({
        ...(await authenticate(getDb(), req.headers.authorization)),
        ...(await authenticateCustomer(getDb(), req.headers.authorization)),
        otpProvider,
        peerIp: req.socket.remoteAddress || "unknown",
        payments,
        customerAuthPresented:
          typeof req.headers.authorization === "string" &&
          req.headers.authorization.trim().length > 0,
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
