import { classQuestionJob } from "./class-question.js";
import type { Job } from "./runner.js";

/** Every scheduled job; the 15-minute tick runs the ones whose window is open. */
export const JOBS: Job[] = [classQuestionJob];
