import { splitProps, type JSX } from "solid-js"
import { type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { buttonVariants } from "./button-variants"

/**
 * Base UI's Button was a styled `<button>` and nothing more — no headless
 * behaviour the app relied on — so it is a plain native button here.
 */
interface ButtonProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

function Button(props: ButtonProps): JSX.Element {
  // splitProps rather than destructuring: props are getters, and destructuring
  // would read them once and freeze the button's variant and class.
  const [local, rest] = splitProps(props, ["class", "variant", "size"])

  return (
    <button
      data-slot="button"
      class={cn(
        buttonVariants({
          variant: local.variant ?? "default",
          size: local.size ?? "default",
          class: local.class,
        }),
      )}
      {...rest}
    />
  )
}

export { Button }
