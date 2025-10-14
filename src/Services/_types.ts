export type Message = {
  content: string;
  senderSocketId: string;
  name: string;
  createdAt: Date;
  type?: "text" | "gif" | "image";
  gifUrl?: string;
  imageUrl?: string;
};
