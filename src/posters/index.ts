import { blueskyPoster } from './bluesky.js';
import { xPoster } from './x.js';
import type { Poster } from './types.js';

export const posters: Poster[] = [xPoster, blueskyPoster];
export { dispatch, anySucceeded, type PostResult } from './dispatcher.js';
export type { Poster, PostInput } from './types.js';
