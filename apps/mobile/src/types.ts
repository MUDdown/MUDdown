import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type GameScreenParams =
  | { readonly wsUrl: string; readonly mode: "guest" }
  | { readonly wsUrl: string; readonly mode: "authenticated"; readonly ticket: string };

export type RootStackParamList = {
  Login: undefined;
  Character: undefined;
  Game: GameScreenParams;
};

export type LoginScreenProps = NativeStackScreenProps<RootStackParamList, "Login">;
export type CharacterScreenProps = NativeStackScreenProps<RootStackParamList, "Character">;
export type GameScreenProps = NativeStackScreenProps<RootStackParamList, "Game">;
