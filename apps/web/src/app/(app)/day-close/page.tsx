import { redirect } from 'next/navigation';

/** The interim day close became the night audit (slice 4.5); old links land there. */
export default function DayClosePage() {
  redirect('/night-audit');
}
