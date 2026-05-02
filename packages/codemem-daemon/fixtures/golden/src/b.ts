import { publicApi } from "./a";

export const bValue: number = publicApi("seed");

export interface AccountShape {
  id: string;
  name: string;
  age: number;
}
