# A construct spinel refuses at compile time, and how it is reported.
# Methods are resolved statically, so one cannot be taken away at run
# time: remove_method is refused rather than approximated
# (docs/limitations.md). The refusal is an error in Diagnostics; the rest
# of the program is still typed -- hover `total` below. Delete the last
# line to make it compile.
class Greeter; def hi = "hi"; end
def total(xs) = xs.sum
puts total([1, 2, 3])
Greeter.remove_method(:hi)
