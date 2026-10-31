/**
 * Shared Tailwind class for theater-form inputs. Switches the border to
 * `border-red-500` when the field has a validation error.
 */
export const inputClass = (hasError: boolean) =>
  `w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed ${
    hasError ? 'border-red-500' : 'border-gray-300'
  }`;
