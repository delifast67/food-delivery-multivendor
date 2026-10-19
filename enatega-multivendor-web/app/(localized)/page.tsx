import ModeHome from "@/lib/ui/screens/unprotected/ModeHome";
import { redirect } from "next/navigation";

export default function RootPage() {
  if (process.env.DELIFAST_LOCAL_MODE === "true") redirect("/delifast");
  return <ModeHome />;
}
