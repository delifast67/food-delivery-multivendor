import { RiderServerMode } from "@/lib/mode/rider-mode";
import { IOrder } from "@/lib/utils/interfaces/order.interface";

export const isNewOrderForMode = (
  order: Pick<IOrder, "orderState" | "orderStatus" | "rider" | "isPickedUp">,
  _mode: RiderServerMode,
) => order.orderStatus === "ACCEPTED" && !order.rider && !order.isPickedUp;

export const isProcessingOrderForMode = (
  order: Pick<IOrder, "orderState" | "orderStatus" | "rider" | "isPickedUp">,
  _mode: RiderServerMode,
) => ["PICKED", "ASSIGNED"].includes(order.orderStatus ?? "") && !order.isPickedUp;

export const canPickupOrderForMode = (
  order: Pick<IOrder, "orderState" | "orderStatus" | "rider">,
  _mode: RiderServerMode,
) => order.orderStatus === "ASSIGNED";

export const canDeliverOrderForMode = (
  order: Pick<IOrder, "orderState" | "orderStatus" | "rider">,
  _mode: RiderServerMode,
) => order.orderStatus === "PICKED";
