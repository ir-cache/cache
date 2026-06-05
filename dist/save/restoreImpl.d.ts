import { IStateProvider } from "./stateProvider";
export declare function restoreImpl(stateProvider: IStateProvider, earlyExit?: boolean): Promise<string | undefined>;
export declare function restoreOnlyRun(earlyExit?: boolean): Promise<void>;
export declare function restoreRun(earlyExit?: boolean): Promise<void>;
