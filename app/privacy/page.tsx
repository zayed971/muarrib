import LegalPage from '../legal-page';
import { PRIVACY } from '@/lib/legal';

export const metadata = {
  title: 'Privacy · Muʿarrib',
};

export default function PrivacyPage() {
  return <LegalPage doc={PRIVACY} />;
}
