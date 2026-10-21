import type { ReactNode } from 'react';
export const metadata = {
  title: 'Delifast — Administration locale',
  description: 'Supervision locale des restaurants et commandes fictives.',
};
export default function LocalLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
