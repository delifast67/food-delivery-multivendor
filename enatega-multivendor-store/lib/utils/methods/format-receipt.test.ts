import {
  formatReceipt,
  formatReceiptOld,
  type ReceiptOrder,
} from "./format-receipt";

const order: ReceiptOrder = {
  _id: "order-1",
  orderId: "DF-1",
  restaurant: {
    _id: "restaurant-1",
    name: "Restaurant",
    image: "",
    address: "",
    location: { coordinates: [0, 0] },
  },
  deliveryAddress: {
    location: { coordinates: [0, 0] },
    deliveryAddress: "10 rue du Marché",
    label: "Maison",
    details: "Étage 2",
  },
  items: [
    {
      _id: "item-1",
      id: "item-1",
      title: "Pizza",
      image: "",
      quantity: 2,
      variation: {
        _id: "variation-1",
        id: "variation-1",
        title: "Grande",
        price: 12.5,
      },
      addons: [
        {
          _id: "addon-1",
          id: "addon-1",
          title: "Extras",
          quantityMinimum: 0,
          quantityMaximum: 1,
          options: [
            { _id: "option-1", id: "option-1", title: "Fromage", price: 1 },
          ],
        },
      ],
      isActive: true,
      createdAt: "",
      updatedAt: "",
    },
  ],
  user: {
    _id: "user-1",
    name: "Client",
    phone: "123",
    email: "client@example.test",
  },
  status: true,
  paymentStatus: "PAID",
  paymentMethod: "COD",
  isActive: true,
  createdAt: "",
  updatedAt: "",
  deliveryCharges: 2,
  tipping: 1,
  taxationAmount: 3,
  orderAmount: 31,
  zone: { _id: "zone-1", name: "Centre" },
  orderDate: "",
  isPickedUp: false,
  isRinged: false,
  isRiderRinged: false,
  discountAmount: 0,
  currencySymbol: "€",
  instructions: "Sonner",
};

describe.each([formatReceipt, formatReceiptOld])(
  "receipt formatter %p",
  (format) => {
    it("preserves quantities, variation prices, addons and amounts", () => {
      const text = format(order);
      expect(text).toContain("2x Pizza (Grande)");
      expect(text).toContain("€12.50");
      expect(text).toContain("Fromage");
      expect(text).toContain("€31.00");
      expect(text).toContain("Delivery");
      expect(text).toContain("Maison");
    });

    it("uses the canonical pickup flag for both address and order type", () => {
      const text = format({ ...order, isPickedUp: true });
      expect(text).toContain("PICKUP");
      expect(text).toContain("Pick up");
      expect(text).not.toContain("Maison");
    });

    it.each(["orderAmount", "deliveryCharges"] as const)(
      "rejects missing %s rather than inventing a zero amount",
      (field) => {
        expect(() => format({ ...order, [field]: undefined })).toThrow(
          `missing ${field}`,
        );
      },
    );
  },
);
