import { provisionForTests } from '@innpilot/db';

export default async function setup(): Promise<void> {
  await provisionForTests();
}
