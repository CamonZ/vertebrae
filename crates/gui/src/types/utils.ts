/**
 * Utility types for common TypeScript patterns.
 *
 * These types help with type manipulation and provide shortcuts
 * for frequently used type transformations.
 */

import type { Result } from "../bindings";

/**
 * Make all properties optional recursively, including nested objects.
 *
 * @typeParam T - The type to make deeply partial
 *
 * @example
 * ```typescript
 * type PartialTask = DeepPartial<Task>;
 * // All fields including nested Section fields are optional
 * ```
 */
export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

/**
 * Make a type nullable (can be T or null).
 *
 * @typeParam T - The base type
 *
 * @example
 * ```typescript
 * type MaybeTask = Nullable<Task>; // Task | null
 * ```
 */
export type Nullable<T> = T | null;

/**
 * Make a type optional (can be T or undefined).
 *
 * @typeParam T - The base type
 *
 * @example
 * ```typescript
 * type MaybeString = Optional<string>; // string | undefined
 * ```
 */
export type Optional<T> = T | undefined;

/**
 * Make specific fields required while keeping others as-is.
 *
 * @typeParam T - The base type
 * @typeParam K - Keys to make required
 *
 * @example
 * ```typescript
 * type TaskWithRequiredId = RequiredFields<Task, 'id'>;
 * // Task with 'id' guaranteed to be non-null
 * ```
 */
export type RequiredFields<T, K extends keyof T> = Omit<T, K> &
  Required<Pick<T, K>>;

/**
 * Pick properties from T whose values are assignable to V.
 *
 * @typeParam T - The source type
 * @typeParam V - The value type to filter by
 *
 * @example
 * ```typescript
 * type StringProps = PickByType<Task, string>;
 * // Only properties that are strings
 * ```
 */
export type PickByType<T, V> = {
  [K in keyof T as T[K] extends V ? K : never]: T[K];
};

/**
 * Omit properties from T whose values are assignable to V.
 *
 * @typeParam T - The source type
 * @typeParam V - The value type to filter out
 *
 * @example
 * ```typescript
 * type NonNullProps = OmitByType<Task, null>;
 * // Properties that cannot be null
 * ```
 */
export type OmitByType<T, V> = {
  [K in keyof T as T[K] extends V ? never : K]: T[K];
};

/**
 * Extract the return type of an async function.
 *
 * @typeParam T - An async function type
 *
 * @example
 * ```typescript
 * async function fetchTask(): Promise<Task> { ... }
 * type TaskResult = AsyncReturnType<typeof fetchTask>; // Task
 * ```
 */
export type AsyncReturnType<
  T extends (...args: unknown[]) => Promise<unknown>,
> = T extends (...args: unknown[]) => Promise<infer R> ? R : never;

/**
 * Unwrap a Result type to get the success data type.
 * Works with the tauri-specta Result type from bindings.
 *
 * @typeParam R - A Result type from bindings
 *
 * @example
 * ```typescript
 * type TaskData = UnwrapResult<Result<Task, CommandError>>; // Task
 * ```
 */
export type UnwrapResult<R> = R extends Result<infer T, unknown> ? T : never;

/**
 * Unwrap a Result type to get the error type.
 *
 * @typeParam R - A Result type from bindings
 *
 * @example
 * ```typescript
 * type ErrorType = UnwrapError<Result<Task, CommandError>>; // CommandError
 * ```
 */
export type UnwrapError<R> = R extends Result<unknown, infer E> ? E : never;
