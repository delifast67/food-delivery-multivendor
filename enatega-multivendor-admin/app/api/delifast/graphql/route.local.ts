import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  if (process.env.DELIFAST_LOCAL_MODE !== 'true')
    return NextResponse.json(
      { error: 'Mode local désactivé' },
      { status: 404 }
    );
  if (!request.headers.get('content-type')?.includes('application/json'))
    return NextResponse.json({ error: 'JSON requis' }, { status: 415 });
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 100000)
      return NextResponse.json(
        { error: 'Requête trop volumineuse' },
        { status: 413 }
      );
    const upstream = await fetch(
      process.env.DELIFAST_API_URL || 'http://127.0.0.1:4000/graphql',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(request.headers.get('authorization')
            ? { authorization: request.headers.get('authorization')! }
            : {}),
        },
        body,
        cache: 'no-store',
        // Never forward GraphQL bodies or sessions to a redirected destination.
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      }
    );
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      {
        errors: [
          {
            message: 'API Delifast indisponible',
            extensions: { code: 'UPSTREAM_UNAVAILABLE' },
          },
        ],
      },
      { status: 502, headers: { 'cache-control': 'no-store' } }
    );
  }
}
