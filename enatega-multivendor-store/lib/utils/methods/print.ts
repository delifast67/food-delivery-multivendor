import * as Print from "expo-print";
import { formatReceipt, type ReceiptOrder } from "./format-receipt";

export const printAsync = async (order: ReceiptOrder, printerUrl?: string) => {
  try {
    return await Print.printAsync({
      width: 576, // 80mm=302px,
      orientation: Print.Orientation.portrait,
      html: formatReceipt(order),
      printerUrl,
    });
  } catch {
    // Printing or selection failure is represented by the null result below.
  }
  return null;
};

export const printToFileAsync = async (order: ReceiptOrder) => {
  try {
    return await Print.printToFileAsync({
      width: 576, // 80mm=302px,
      html: formatReceipt(order),
    });
  } catch {
    // Printing or selection failure is represented by the null result below.
  }
  return null;
};

export const selectPrinterAsync = async () => {
  try {
    const { name, url } = await Print.selectPrinterAsync();
    return { name, url };
  } catch {
    // Printing or selection failure is represented by the null result below.
  }
  return null;
};
