# A class whose fields spinel unboxes: hover @x, @y, dist2 and o.
# `o` reaches dist2 through a poly array element, so that parameter is
# widened to untyped (the marker is on `o`) and the call to dist2 below
# is dispatched through a switch over the classes p can hold -- see
# Diagnostics, Signatures and Codegen.
class Point
  def initialize(x, y) = (@x, @y = x, y)
  def dist2(o) = (@x - o.x) ** 2 + (@y - o.y) ** 2
  attr_reader :x, :y
end
pts = (1..5).map { |i| Point.new(i, i * 2) }
puts pts.map { |p| p.dist2(pts[0]) }.inspect
