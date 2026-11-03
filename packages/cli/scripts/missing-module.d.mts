import type { Plugin } from 'rolldown'

export declare const NATIVE: RegExp
export declare const OPTIONAL: Set<string>
export declare const INSTALLABLE: Set<string>
export declare function missingModuleSource(name: string): string
export declare const AWS_SDK: string
export declare function awsSdkSource(): string
export declare function installableSource(name: string): string
export declare function missingModulesPlugin(opts?: { installable?: boolean }): Plugin
