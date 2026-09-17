# A class whose fields spinel unboxes: hover @x, @y, dist2 and o.
# `o` reaches dist2 through a poly array element, so its parameter is
# widened to untyped and the method is marked a slow path -- see
# Diagnostics and Signatures.
class Point
  def initialize(x, y) = (@x, @y = x, y)
  def dist2(o) = (@x - o.x) ** 2 + (@y - o.y) ** 2
  attr_reader :x, :y
end
pts = (1..5).map { |i| Point.new(i, i * 2) }
puts pts.map { |p| p.dist2(pts[0]) }.inspect
