export interface PostInput {
  asin: string;
  text: string;
}

export interface PostOutput {
  url?: string;
}

export interface Poster {
  name: string;
  post(input: PostInput): Promise<PostOutput>;
}
