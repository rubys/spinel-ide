# Mixed element types widen a whole call chain to untyped.
# `Item.new(1)` and `Item.new(2.5)` give @price two types, so @price, the
# initializer and `total` all take the boxed slow path (warnings in
# Diagnostics, `untyped` in Signatures). Make both prices Integers and
# @price and the initializer narrow to Integer; `total` keeps its warning,
# because a literal array of objects is a poly array (Array[untyped]).
class Item
  attr_reader :price
  def initialize(p) = @price = p
end

def total(items)
  items.sum { |i| i.price }
end

puts total([Item.new(1), Item.new(2.5)])
