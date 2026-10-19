import { provisionForTests } from './testing';

export default async function setup(): Promise<void> {
  await provisionForTests();
}
