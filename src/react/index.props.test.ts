/**
 * The React wrappers expose the slot as `vioSlot` (ADR-0027).
 *
 * `react` is an optional peer and is not installed here, so this is a
 * COMPILE-TIME check: `@lit/react` derives the props from the element class,
 * and `tsc --noEmit` (npm run typecheck) fails if `vioSlot` is not among them
 * or has another type. Type-only imports keep the runtime free of React.
 */

import { describe, expectTypeOf, it } from 'vitest'
import type { ComponentProps } from 'react'
import type { VioProduct, VioProductCarousel, VioProductDetail } from './index.js'

type ProductProps = ComponentProps<typeof VioProduct>
type CarouselProps = ComponentProps<typeof VioProductCarousel>
type DetailProps = ComponentProps<typeof VioProductDetail>

describe('React wrappers', () => {
  it('type `vioSlot` on the three product wrappers', () => {
    expectTypeOf<ProductProps['vioSlot']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<CarouselProps['vioSlot']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<DetailProps['vioSlot']>().toEqualTypeOf<string | undefined>()
  })

  it('keep the element identifiers reachable alongside it', () => {
    expectTypeOf<ProductProps['sponsorId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<CarouselProps['productIds']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<DetailProps['productId']>().toEqualTypeOf<string | undefined>()
  })
})
