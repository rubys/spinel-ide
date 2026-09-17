# A construct spinel refuses at compile time, and how it is reported.
# Inspecting a Fiber needs state the compiled handle does not keep, so
# `p f` is refused rather than approximated (docs/limitations.md). The
# refusal is an error in Diagnostics; the rest of the program is still
# typed -- hover `total` below. Delete the last line to make it compile.
def total(xs) = xs.sum
puts total([1, 2, 3])
f = Fiber.new { 1 }
p f
