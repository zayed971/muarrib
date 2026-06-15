import LegalPage from '../legal-page';
import { TERMS } from '@/lib/legal';

export const metadata = {
  title: 'Terms · Muʿarrib',
};

export default function TermsPage() {
  return <LegalPage doc={TERMS} />;
}
