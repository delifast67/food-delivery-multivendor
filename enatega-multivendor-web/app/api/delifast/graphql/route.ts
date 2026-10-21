import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const target =
    process.env.DELIFAST_API_URL || "http://localhost:4000/graphql";
  let body: string;
  try {
    body = await request.text();
  } catch {
    return NextResponse.json(
      { errors: [{ message: "Requête invalide" }] },
      { status: 400 },
    );
  }
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(request.headers.get("authorization")
          ? { authorization: request.headers.get("authorization") as string }
          : {}),
      },
      body,
      cache: "no-store",
      // Never forward GraphQL bodies or sessions to a redirected destination.
      redirect: "error",
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch {
    return NextResponse.json(
      { errors: [{ message: "Backend Delifast local indisponible" }] },
      { status: 502 },
    );
  }
}
