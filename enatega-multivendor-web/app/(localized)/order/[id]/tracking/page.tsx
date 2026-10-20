"use client";
import OrderTrackingScreen from "@/lib/ui/screens/protected/order/tracking";
import {useParams} from "next/navigation";
export default function Page(){const {id}=useParams<{id:string}>(); return <OrderTrackingScreen orderId={id}/>;}
