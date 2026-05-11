export interface PostInput {
  asin: string;
  text: string;
}

export interface Poster {
  name: string;
  post(input: PostInput): Promise<void>;
}
