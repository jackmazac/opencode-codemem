import { bValue } from "./b";

export function publicApi(input: string) {
  const value = input.trim();
  if (value.length === 0) {
    return bValue;
  }
  return value.length;
}

export interface UserShape {
  id: string;
  name: string;
  age: number;
}
