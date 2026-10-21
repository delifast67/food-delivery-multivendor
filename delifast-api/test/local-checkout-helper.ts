import { afterAll, beforeAll } from "vitest";

// Import explicitly only in suites exercising synthetic local order submissions.
// Do not use as global setup: closed-by-default tests must see the real default.
const previous = process.env.DELIFAST_ALLOW_NONATOMIC_CHECKOUT;
beforeAll(() => { process.env.DELIFAST_ALLOW_NONATOMIC_CHECKOUT = "true"; });
afterAll(() => {
  if (previous === undefined) delete process.env.DELIFAST_ALLOW_NONATOMIC_CHECKOUT;
  else process.env.DELIFAST_ALLOW_NONATOMIC_CHECKOUT = previous;
});
