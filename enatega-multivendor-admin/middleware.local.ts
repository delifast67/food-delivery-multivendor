import { NextRequest, NextResponse } from 'next/server';
export function middleware(request: NextRequest) {
  if (process.env.DELIFAST_LOCAL_MODE !== 'true') return NextResponse.next();
  const path = request.nextUrl.pathname;
  if (
    path === '/delifast' ||
    path === '/api/delifast/graphql' ||
    path.startsWith('/_next/')
  )
    return NextResponse.next();
  if (path.startsWith('/api/'))
    return NextResponse.json(
      { error: 'API indisponible dans ce lot local' },
      { status: 404 }
    );
  const destination = request.nextUrl.clone();
  destination.pathname = '/delifast';
  destination.search = '';
  return NextResponse.redirect(destination);
}
export const config = { matcher: ['/:path*'] };
