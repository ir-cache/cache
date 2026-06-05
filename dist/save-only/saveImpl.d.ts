import { IStateProvider } from "./stateProvider";
export declare function saveImpl(stateProvider: IStateProvider): Promise<number | void>;
export declare function saveOnlyRun(earlyExit?: boolean): Promise<void>;
export declare function saveRun(earlyExit?: boolean): Promise<void>;
