import * as Cesium from "cesium"

/**
 * Cesium 变换控制器 (TransformGizmo)
 * 
 * 一个用于 CesiumJS 应用的强大变换工具，提供对 3D 模型和 3D Tileset 的交互式平移、旋转和缩放功能。
 * 
 * @description
 * TransformGizmo 类创建一个可视化的操作手柄（Gizmo），附加到 Cesium 实体（Model 或 Cesium3DTileset）上。
 * 用户可以通过拖拽 TransformGizmo 的轴来在 3D 空间中变换对象。
 * 支持三种模式：
 * - `translate` (平移): 沿 X, Y, Z 轴移动对象。
 * - `rotate` (旋转): 绕 X, Y, Z 轴旋转对象。
 * - `scale` (缩放): 沿轴缩放对象。
 * 
 * 主要特性：
 * - 支持 Model 和 Cesium3DTileset
 * - 自动处理坐标系转换
 * - 包含轴高亮和交互反馈
 * - 提供实时状态更新回调
 * 
 * @example
  // 1. 初始化 Cesium Viewer
  const viewer = new Cesium.Viewer('cesiumContainer');
  
  // 2. 加载模型
  const position = Cesium.Cartesian3.fromDegrees(-123.0744619, 44.0503706, 0);
  const entity = viewer.entities.add({
    position: position,
    model: {
      uri: 'path/to/model.gltf'
    }
  });
  
  // 注意：Gizmo 目前主要支持 Primitive 层的 Model 或 Tileset，
  // 如果使用 Entity API，可以通过 entity.model._primitive 获取（需等待加载完成）
  // 或者直接使用 viewer.scene.primitives.add 加载 Model。
  const model = await Cesium.Model.fromGltf({ url: 'path/to/model.gltf' });
  viewer.scene.primitives.add(model);
  
  // 3. 创建 TransformGizmo
  const gizmo = new TransformGizmo({
    viewer: viewer,
    object: model,
    mode: 'translate',
    onUpdate: (state) => {
      console.log('新位置:', state.position);
      console.log('新旋转:', state.rotation);
      console.log('新缩放:', state.scale);
    }
  });
  
  // 4. 切换模式
  gizmo.mode = 'rotate'; // 切换到旋转模式
  gizmo.mode = 'scale'; // 切换到缩放模式
  
  // 5.切换绑定对象
  gizmo.bindObject(entity.model._primitive) // 切换到实体的 Model
  gizmo.bindObject(tileset) // 切换到 3DTileset
  
  // 6. 解绑当前绑定对象
  gizmo.bindObject()
  
  // 7. 鼠标点击时拾取模型或3DTileset，绑定到Gizmo进行操作
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)
  handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const res = viewer?.scene.pick(e.position)
    if (
      res &&
      (res.primitive instanceof Cesium.Cesium3DTileset || res.primitive instanceof Cesium.Model)
    ) {
      gizmo?.bindObject(res.primitive)
    } else {
      gizmo?.bindObject()
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
 */
export class TransformGizmo {
  // --- 核心属性 ---
  public viewer: Cesium.Viewer
  public object: Cesium.Model | Cesium.Cesium3DTileset | undefined

  // --- 几何参数 ---
  public center: Cesium.Cartesian3 | undefined
  public axisLength: number = 120
  private _width: number
  private _centerRadius: number = 0.05

  // --- 颜色配置 ---
  public colors = {
    X: Cesium.Color.fromCssColorString("#EA3323"),
    Y: Cesium.Color.fromCssColorString("#4CE600"),
    Z: Cesium.Color.fromCssColorString("#0036FF"),
  }

  // --- 状态控制 ---
  private _mode: TransformMode = "translate"
  private _activeScale: Cesium.Cartesian3 = new Cesium.Cartesian3(1, 1, 1)

  // --- 图元资源 ---
  private _primitives: Cesium.PrimitiveCollection
  private _axisPrimitives: { [key: string]: Cesium.Primitive } = {}
  private _colliders: GizmoCollider[] = []

  // --- 交互事件 ---
  private _handler: Cesium.ScreenSpaceEventHandler | undefined
  private _isDragging: boolean = false
  private _dragAxisName: string = ""
  private _dragPlane: Cesium.Plane | undefined

  // --- 交互计算中间量 ---
  private _dragStartPoint = new Cesium.Cartesian3()
  private _dragStartCenter = new Cesium.Cartesian3()
  private _dragVectorStart = new Cesium.Cartesian3()
  private _initialModelMatrix = new Cesium.Matrix4()

  // --- 高亮与视觉反馈 ---
  private _highlightedId: GizmoId | null = null
  private _outlineStage: Cesium.PostProcessStageComposite | undefined
  private _edgeDetectionStage: any | undefined

  // --- 钩子函数 ---
  onUpdate?: (e: TransformState | null) => void

  constructor(options: Options) {
    const {
      viewer,
      object,
      axisWidth = 5,
      mode = "translate",
      onUpdate,
    } = options
    this.viewer = viewer
    this._width = axisWidth
    this._mode = mode

    this._primitives = new Cesium.PrimitiveCollection()
    this.viewer.scene.primitives.add(this._primitives)

    this.initOutlineStage()

    this.initControlEvents()
    this.viewer.scene.preUpdate.addEventListener(this.update, this)

    this.onUpdate = onUpdate

    if (object) {
      this.bindObject(object)
    }
  }

  get mode() {
    return this._mode
  }
  set mode(val: TransformMode) {
    if (this._mode !== val) {
      this._mode = val
      this.createGizmo()
    }
  }

  /**
   * 绑定操作对象
   * @param object 要绑定的模型或3DTileset对象，如果不传入则解绑当前绑定对象
   */
  public bindObject(object?: Cesium.Model | Cesium.Cesium3DTileset) {
    // 1. 如果传入 null，则视为解绑
    if (!object) {
      this.detach()
      return
    }

    // 2. 如果对象没有变化，直接返回
    if (this.object === object) return

    // 3. 清理旧状态 (停止拖拽、取消高亮等)
    this.resetState()

    // 4. 绑定新模型
    this.object = object
    this.parseCenter()

    // 5. 重新创建 TransformGizmo (位置更新)
    this.createGizmo()

    // 6. 更新描边选中对象
    this.updateOutlineSelection()

    // 7. 更新模型变换参数
    this.onUpdate && this.onUpdate(this.getTransformState())
  }

  /**
   * 获取当前模型的变换状态
   */
  public getTransformState(): TransformState | null {
    if (!this.object || !this.center) return null

    let modelMatrix = this.object.modelMatrix

    // --- A. 提取位置 (Translation) ---
    const position = new Cesium.Cartesian3()
    Cesium.Matrix4.getTranslation(modelMatrix, position)

    // --- B. 提取缩放 (Scale) ---
    const scale = new Cesium.Cartesian3()
    Cesium.Matrix4.getScale(modelMatrix, scale)

    // [修复1] 缩放精度修约
    const cleanScale = (val: number) => {
      if (Math.abs(val - 1.0) < 0.00001) return 1.0
      return parseFloat(val.toFixed(3))
    }

    // --- C. 提取旋转 (Rotation) ---
    const rotationMatrix = new Cesium.Matrix3()
    Cesium.Matrix4.getMatrix3(modelMatrix, rotationMatrix)

    const column0 = Cesium.Matrix3.getColumn(
      rotationMatrix,
      0,
      new Cesium.Cartesian3()
    )
    const column1 = Cesium.Matrix3.getColumn(
      rotationMatrix,
      1,
      new Cesium.Cartesian3()
    )
    const column2 = Cesium.Matrix3.getColumn(
      rotationMatrix,
      2,
      new Cesium.Cartesian3()
    )
    Cesium.Cartesian3.normalize(column0, column0)
    Cesium.Cartesian3.normalize(column1, column1)
    Cesium.Cartesian3.normalize(column2, column2)
    Cesium.Matrix3.setColumn(rotationMatrix, 0, column0, rotationMatrix)
    Cesium.Matrix3.setColumn(rotationMatrix, 1, column1, rotationMatrix)
    Cesium.Matrix3.setColumn(rotationMatrix, 2, column2, rotationMatrix)

    // 2. 计算 ENU 参考系
    const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(position)
    const enuRotation = new Cesium.Matrix3()
    Cesium.Matrix4.getMatrix3(enuMatrix, enuRotation)

    // 3. 计算相对旋转
    const enuRotationInverse = new Cesium.Matrix3()
    Cesium.Matrix3.inverse(enuRotation, enuRotationInverse)

    const localRotation = new Cesium.Matrix3()
    Cesium.Matrix3.multiply(enuRotationInverse, rotationMatrix, localRotation)

    // 4. 转换为欧拉角
    const hpr = Cesium.HeadingPitchRoll.fromQuaternion(
      Cesium.Quaternion.fromRotationMatrix(localRotation)
    )

    // [修复2] 角度清洗函数
    const toDegrees = (rad: number) => {
      if (Math.abs(rad) < 1e-10) rad = 0
      let degree = Cesium.Math.toDegrees(rad)
      degree = degree % 360
      if (degree < 0) degree += 360
      if (Math.abs(degree - 360) < 0.01) degree = 0
      if (Math.abs(degree) < 0.01) degree = 0
      return parseFloat(degree.toFixed(2))
    }

    const state = {
      position: {
        x: parseFloat(position.x.toFixed(2)),
        y: parseFloat(position.y.toFixed(2)),
        z: parseFloat(position.z.toFixed(2)),
      },
      rotation: {
        heading: toDegrees(hpr.heading),
        pitch: toDegrees(hpr.pitch),
        roll: toDegrees(hpr.roll),
      },
      scale: {
        x: cleanScale(scale.x),
        y: cleanScale(scale.y),
        z: cleanScale(scale.z),
      },
      modelMatrix: modelMatrix.toString().replaceAll(")\n(", ","),
    }

    return state
  }

  //销毁Gizmo
  public destroy() {
    this.viewer.scene.preUpdate.removeEventListener(this.update, this)
    this.viewer.scene.primitives.remove(this._primitives)

    if (this._outlineStage) {
      this.viewer.scene.postProcessStages.remove(this._outlineStage)
    }

    if (this._handler) {
      this._handler.destroy()
      this._handler = undefined
    }
  }

  /**
   * 解绑当前对象，隐藏 TransformGizmo
   */
  detach() {
    this.resetState()
    this.object = null as any // 临时处理类型，或者修改属性定义允许为 null
    this.center = undefined

    // 清空 TransformGizmo
    this._primitives.removeAll()
    this._colliders = []
    this._axisPrimitives = {}

    // 清空描边
    if (this._edgeDetectionStage) {
      this._edgeDetectionStage.selected = []
    }
  }

  /**
   * 更新描边逻辑封装
   */
  private updateOutlineSelection() {
    if (!this._edgeDetectionStage) return

    if (
      this.object instanceof Cesium.Model ||
      this.object instanceof Cesium.Cesium3DTileset
    ) {
      this._edgeDetectionStage.selected = [this.object]
    } else {
      // 如果是 Cartesian3 (点) 或者其他，不进行描边
      this._edgeDetectionStage.selected = []
    }
  }

  /**
   * 内部状态重置
   */
  private resetState() {
    this._isDragging = false
    this._dragAxisName = ""
    this._dragPlane = undefined
    this._activeScale = new Cesium.Cartesian3(1, 1, 1)

    // 清除 TransformGizmo 高亮
    this.restoreHighlight()
    this._highlightedId = null

    // 恢复相机控制 (防止在拖拽中途切换导致相机锁死)
    const controller = this.viewer.scene.screenSpaceCameraController
    if (!controller.enableRotate) controller.enableRotate = true
    if (!controller.enableTranslate) controller.enableTranslate = true
  }

  private parseCenter() {
    if (
      this.object instanceof Cesium.Cesium3DTileset ||
      this.object instanceof Cesium.Model
    ) {
      this.center = this.object.boundingSphere.center.clone()
    } else {
      this.center = this.object
    }
  }

  private initOutlineStage() {
    if (
      !Cesium.PostProcessStageLibrary.isSilhouetteSupported(this.viewer.scene)
    ) {
      console.warn("当前环境不支持模型描边 (Silhouette)")
      return
    }
    const edgeDetection =
      Cesium.PostProcessStageLibrary.createEdgeDetectionStage()
    edgeDetection.uniforms.color = Cesium.Color.YELLOW
    edgeDetection.uniforms.length = 0.01
    // @ts-ignore
    edgeDetection.selected = []
    this._edgeDetectionStage = edgeDetection

    this._outlineStage = Cesium.PostProcessStageLibrary.createSilhouetteStage([
      edgeDetection,
    ])
    this.viewer.scene.postProcessStages.add(this._outlineStage)
  }

  // ==================================================================================
  //                                  1. 几何体与碰撞体创建
  // ==================================================================================

  private createGizmo() {
    this._primitives.removeAll()
    this._axisPrimitives = {}
    this._colliders = []

    if (this._mode === "translate") {
      this.createTranslationGizmo()
    } else if (this._mode === "rotate") {
      this.createRotationGizmo()
    } else if (this._mode === "scale") {
      this.createScaleGizmo()
    }
    this.createCenterGizmo()
  }

  private getAppearance(color: Cesium.Color, isLine: boolean = false) {
    const renderState = {
      depthTest: { enabled: false }, // 禁用深度测试，透视显示
      depthMask: false,
      cull: { enabled: false }, // 双面渲染
      blending: Cesium.BlendingState.ALPHA_BLEND,
    }
    if (isLine) {
      return new Cesium.PolylineColorAppearance({
        translucent: true,
        renderState: renderState,
      })
    } else {
      return new Cesium.PerInstanceColorAppearance({
        translucent: true,
        flat: true,
        renderState: renderState,
      })
    }
  }

  private addCollider(
    key: string,
    id: GizmoId,
    min: Cesium.Cartesian3,
    max: Cesium.Cartesian3,
    type: ColliderType = "BOX",
    extraParams: any = {}
  ) {
    this._colliders.push({
      id,
      type,
      localMin: min,
      localMax: max,
      primitiveKey: key,
      ...extraParams,
    })
  }

  private createCenterGizmo() {
    // 保持不透明白色
    const color = Cesium.Color.WHITE.clone()
    const type = this._mode === "scale" ? "scale" : "center"
    const id = { axis: "CENTER", type: type, name: "CENTER" } as GizmoId

    const radius = this._centerRadius
    const geometry = new Cesium.EllipsoidGeometry({
      radii: new Cesium.Cartesian3(radius, radius, radius),
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    })

    const instance = new Cesium.GeometryInstance({
      geometry: geometry,
      modelMatrix: Cesium.Matrix4.IDENTITY,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
      },
      id: id,
    })

    const primitive = new Cesium.Primitive({
      geometryInstances: [instance],
      appearance: this.getAppearance(color, false),
      asynchronous: false,
    })

    this._primitives.add(primitive)
    this._axisPrimitives["CENTER"] = primitive

    this.addCollider(
      "CENTER",
      id,
      new Cesium.Cartesian3(-radius, -radius, -radius),
      new Cesium.Cartesian3(radius, radius, radius),
      "BOX"
    )
  }

  private createTranslationGizmo() {
    const axes: ("X" | "Y" | "Z")[] = ["X", "Y", "Z"]
    const colors = this.colors
    const directions = {
      X: new Cesium.Cartesian3(1, 0, 0),
      Y: new Cesium.Cartesian3(0, 1, 0),
      Z: new Cesium.Cartesian3(0, 0, 1),
    }

    axes.forEach((axis) => {
      const gizmoId = {
        axis,
        type: "translate",
        name: `TRANS_${axis}`,
      } as GizmoId
      const arrowLength = 0.15
      const lineLength = 1.0

      // 轴线避让中心球
      const startPoint = Cesium.Cartesian3.multiplyByScalar(
        directions[axis],
        this._centerRadius,
        new Cesium.Cartesian3()
      )

      const lineInstance = new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions: [startPoint, directions[axis]],
          width: this._width,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
          arcType: Cesium.ArcType.NONE,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(colors[axis]),
        },
        id: gizmoId,
      })

      const arrowInstance = new Cesium.GeometryInstance({
        geometry: new Cesium.CylinderGeometry({
          length: arrowLength,
          topRadius: 0,
          bottomRadius: 0.04,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        modelMatrix: Cesium.Matrix4.IDENTITY,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(colors[axis]),
        },
        id: gizmoId,
      })

      const pLine = new Cesium.Primitive({
        geometryInstances: [lineInstance],
        appearance: this.getAppearance(colors[axis], true),
        asynchronous: false,
      })
      const pArrow = new Cesium.Primitive({
        geometryInstances: [arrowInstance],
        appearance: this.getAppearance(colors[axis], false),
        asynchronous: false,
      })

      this._primitives.add(pLine)
      this._primitives.add(pArrow)

      const keyLine = `${axis}_line`
      const keyArrow = `${axis}_arrow`
      this._axisPrimitives[keyLine] = pLine
      this._axisPrimitives[keyArrow] = pArrow

      const colliderWidth = 0.1
      const totalLen = lineLength + arrowLength

      let min = new Cesium.Cartesian3()
      let max = new Cesium.Cartesian3()

      if (axis === "X") {
        min = new Cesium.Cartesian3(0, -colliderWidth, -colliderWidth)
        max = new Cesium.Cartesian3(totalLen, colliderWidth, colliderWidth)
      } else if (axis === "Y") {
        min = new Cesium.Cartesian3(-colliderWidth, 0, -colliderWidth)
        max = new Cesium.Cartesian3(colliderWidth, totalLen, colliderWidth)
      } else {
        min = new Cesium.Cartesian3(-colliderWidth, -colliderWidth, 0)
        max = new Cesium.Cartesian3(colliderWidth, colliderWidth, totalLen)
      }
      this.addCollider(keyLine, gizmoId, min, max, "BOX")
    })

    const start = 0.15
    const end = 0.45
    const thickness = 0.01

    const planes = [
      {
        axis: "XY" as const,
        color: colors.Z.withAlpha(0.5),
        min: new Cesium.Cartesian3(start, start, -thickness),
        max: new Cesium.Cartesian3(end, end, thickness),
      },
      {
        axis: "YZ" as const,
        color: colors.X.withAlpha(0.5),
        min: new Cesium.Cartesian3(-thickness, start, start),
        max: new Cesium.Cartesian3(thickness, end, end),
      },
      {
        axis: "ZX" as const,
        color: colors.Y.withAlpha(0.5),
        min: new Cesium.Cartesian3(start, -thickness, start),
        max: new Cesium.Cartesian3(end, thickness, end),
      },
    ]

    planes.forEach((plane) => {
      const gizmoId = {
        axis: plane.axis,
        type: "translate",
        name: `PLANE_${plane.axis}`,
      } as GizmoId

      const boxGeometry = new Cesium.BoxGeometry({
        minimum: plane.min,
        maximum: plane.max,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      })

      const instance = new Cesium.GeometryInstance({
        geometry: boxGeometry,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(plane.color),
        },
        id: gizmoId,
      })

      const primitive = new Cesium.Primitive({
        geometryInstances: [instance],
        appearance: this.getAppearance(plane.color, false),
        asynchronous: false,
      })

      const key = `PLANE_${plane.axis}`
      this._primitives.add(primitive)
      this._axisPrimitives[key] = primitive
      this.addCollider(key, gizmoId, plane.min, plane.max, "BOX")
    })
  }

  /**
   * 创建 90度扇形旋转手柄 (Polyline 线框版)
   */
  private createRotationGizmo() {
    const axes: ("X" | "Y" | "Z")[] = ["X", "Y", "Z"]
    const colors = this.colors
    const radius = 1.0
    // 线宽 (像素单位，注意：PolylineWidth 在某些 WebGL 实现中受限，通常最大为 1px 或需特殊处理，但在 Cesium 中通常有效)
    const lineWidth = 3.0

    // 1. 核心工具：根据轴向，直接生成 90度 圆弧点
    // 用于 扇形面(Fan) 和 边框线(Rim)
    const getArcPoints = (axis: string) => {
      const positions: Cesium.Cartesian3[] = []
      // 精度：5度一个点
      for (let i = 0; i <= 90; i += 5) {
        const rad = Cesium.Math.toRadians(i)
        const c = Math.cos(rad) * radius
        const s = Math.sin(rad) * radius

        if (axis === "Z") {
          // Z轴: XY平面 (X -> Y)
          positions.push(new Cesium.Cartesian3(c, s, 0))
        } else if (axis === "X") {
          // X轴: YZ平面 (Y -> Z)
          positions.push(new Cesium.Cartesian3(0, c, s))
        } else if (axis === "Y") {
          // Y轴: ZX平面 (Z -> X)
          positions.push(new Cesium.Cartesian3(s, 0, c))
        }
      }
      return positions
    }

    axes.forEach((axis) => {
      const gizmoId = { axis, type: "rotate", name: `ROT_${axis}` } as GizmoId

      // 获取当前轴的路径点
      const arcPoints = getArcPoints(axis)

      // ==========================================
      // A. 创建扇形面 (Fan) - 手动构建 Mesh
      // ==========================================
      const fanPositions: number[] = []
      const fanIndices: number[] = []

      // 圆心 (0,0,0)+e to avoid race condition
      fanPositions.push(1e-10, 1e-10, 1e-10)
      // 添加圆弧点
      arcPoints.forEach((p) => fanPositions.push(p.x, p.y, p.z))

      // 构建三角形 (Center -> Current -> Next)
      for (let i = 1; i < arcPoints.length; i++) {
        fanIndices.push(0, i, i + 1)
      }

      const attributes = new Cesium.GeometryAttributes()
      attributes.position = new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: new Float64Array(fanPositions),
      })

      const fanGeometry = new Cesium.Geometry({
        attributes,
        indices: new Uint16Array(fanIndices),
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: new Cesium.BoundingSphere(
          new Cesium.Cartesian3(1e-10, 1e-10, 1e-10), // avoid race condition
          radius
        ),
      })

      // ==========================================
      // B. 创建边框线 (Rim) - 使用 Polyline
      // ==========================================
      // 为了让线框看起来闭合，我们可以把圆心也加进去，或者只画圆弧。
      // UE5 风格通常有两条直边 + 一条圆弧。
      // 这里构建：圆心 -> 第一点 -> ...弧线... -> 最后点 -> 圆心
      const linePositions = [...arcPoints]

      const rimGeometry = new Cesium.PolylineGeometry({
        positions: linePositions,
        width: lineWidth,
        vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        arcType: Cesium.ArcType.NONE, // 关键：禁用测地线，直接连线
      })

      // ==========================================
      // C. 创建 Primitive
      // ==========================================
      const modelMatrix = Cesium.Matrix4.IDENTITY

      // 1. 扇形面实例
      const fanColor = colors[axis].withAlpha(0.2)
      const fanInstance = new Cesium.GeometryInstance({
        geometry: fanGeometry,
        modelMatrix: modelMatrix,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(fanColor),
        },
        id: gizmoId,
      })

      // 2. 边框线实例
      const rimInstance = new Cesium.GeometryInstance({
        geometry: rimGeometry,
        modelMatrix: modelMatrix,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(colors[axis]),
        },
        id: gizmoId,
      })

      // 注意：线和面需要不同的 Appearance，所以最好分成两个 Primitive，或者使用支持两者的特殊写法。
      // 但最简单稳妥的方法是：加两个 Primitive。
      // 为了管理方便，我们还是把它们加到一个 update 逻辑里。

      // Primitive 1: 扇形面
      const fanPrimitive = new Cesium.Primitive({
        geometryInstances: [fanInstance],
        appearance: this.getAppearance(colors[axis], false), // 面着色
        asynchronous: false,
      })

      // Primitive 2: 边框线
      const rimPrimitive = new Cesium.Primitive({
        geometryInstances: [rimInstance],
        appearance: this.getAppearance(colors[axis], true), // 线着色
        asynchronous: false,
      })

      this._primitives.add(fanPrimitive)
      this._primitives.add(rimPrimitive)

      // 存入引用以便 update (存一个对象包含两者)
      // 这里我们需要修改 _axisPrimitives 的类型定义，或者简单地存入一个复合对象
      // 为了不破坏 update 逻辑，我们可以利用 JS 对象的动态性，或者给 key 加后缀
      this._axisPrimitives[`${axis}_fan`] = fanPrimitive
      this._axisPrimitives[`${axis}_rim`] = rimPrimitive
      // 同时保留 axis key 指向其中一个（通常没用，update里会改）
      // 我们将在 update 里专门处理 _fan 和 _rim 后缀

      // ==========================================
      // D. 碰撞体 (Sector)
      // ==========================================
      const tube = 0.05 // 虚拟厚度
      const r = radius + tube
      let min = new Cesium.Cartesian3()
      let max = new Cesium.Cartesian3()
      let ringNormalAxis: 0 | 1 | 2 = 2

      if (axis === "Z") {
        min = new Cesium.Cartesian3(0, 0, -tube)
        max = new Cesium.Cartesian3(r, r, tube)
        ringNormalAxis = 2
      } else if (axis === "X") {
        min = new Cesium.Cartesian3(-tube, 0, 0)
        max = new Cesium.Cartesian3(tube, r, r)
        ringNormalAxis = 0
      } else if (axis === "Y") {
        min = new Cesium.Cartesian3(0, -tube, 0)
        max = new Cesium.Cartesian3(r, tube, r)
        ringNormalAxis = 1
      }

      this.addCollider(axis, gizmoId, min, max, "SECTOR", {
        radius: radius,
        tube: tube, // 点击容差
        ringNormalAxis: ringNormalAxis,
        startAngle: 0,
        endAngle: Math.PI / 2,
      })
    })
  }

  private createScaleGizmo() {
    const axes: ("X" | "Y" | "Z")[] = ["X", "Y", "Z"]
    const colors = this.colors
    const directions = {
      X: new Cesium.Cartesian3(1, 0, 0),
      Y: new Cesium.Cartesian3(0, 1, 0),
      Z: new Cesium.Cartesian3(0, 0, 1),
    }

    axes.forEach((axis) => {
      const gizmoId = { axis, type: "scale", name: `SCALE_${axis}` } as GizmoId

      const startPoint = Cesium.Cartesian3.multiplyByScalar(
        directions[axis],
        this._centerRadius,
        new Cesium.Cartesian3()
      )

      const lineInstance = new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions: [startPoint, directions[axis]],
          width: this._width,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
          arcType: Cesium.ArcType.NONE,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(colors[axis]),
        },
        id: gizmoId,
      })

      const boxGeometry = new Cesium.BoxGeometry({
        minimum: new Cesium.Cartesian3(-0.05, -0.05, -0.05),
        maximum: new Cesium.Cartesian3(0.05, 0.05, 0.05),
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      })
      const boxInstance = new Cesium.GeometryInstance({
        geometry: boxGeometry,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(colors[axis]),
        },
        id: gizmoId,
      })

      const pLine = new Cesium.Primitive({
        geometryInstances: [lineInstance],
        appearance: this.getAppearance(colors[axis], true),
        asynchronous: false,
      })
      const pBox = new Cesium.Primitive({
        geometryInstances: [boxInstance],
        appearance: this.getAppearance(colors[axis], false),
        asynchronous: false,
      })

      const keyLine = `${axis}_line`
      const keyBox = `${axis}_box`

      this._primitives.add(pLine)
      this._primitives.add(pBox)
      this._axisPrimitives[keyLine] = pLine
      this._axisPrimitives[keyBox] = pBox

      const colliderWidth = 0.1
      let min = new Cesium.Cartesian3()
      let max = new Cesium.Cartesian3()
      if (axis === "X") {
        min = new Cesium.Cartesian3(0, -colliderWidth, -colliderWidth)
        max = new Cesium.Cartesian3(1.1, colliderWidth, colliderWidth)
      } else if (axis === "Y") {
        min = new Cesium.Cartesian3(-colliderWidth, 0, -colliderWidth)
        max = new Cesium.Cartesian3(colliderWidth, 1.1, colliderWidth)
      } else {
        min = new Cesium.Cartesian3(-colliderWidth, -colliderWidth, 0)
        max = new Cesium.Cartesian3(colliderWidth, colliderWidth, 1.1)
      }
      this.addCollider(keyLine, gizmoId, min, max, "BOX")
    })
  }

  // ==================================================================================
  //                                  2. 帧更新循环
  // ==================================================================================

  private update() {
    if (!this.center) return

    const scene = this.viewer.scene
    const camera = scene.camera

    // 1. 计算基础参数
    const pixelSize = camera.getPixelSize(
      new Cesium.BoundingSphere(this.center, 0),
      this.viewer.canvas.clientWidth,
      this.viewer.canvas.clientHeight
    )
    const baseScale = pixelSize * this.axisLength
    const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(this.center)
    const inverseEnu = Cesium.Matrix4.inverse(enuMatrix, new Cesium.Matrix4())

    // 2. 计算相机在 TransformGizmo 局部坐标系下的位置向量
    const centerToCamera = Cesium.Cartesian3.subtract(
      camera.position,
      this.center,
      new Cesium.Cartesian3()
    )
    const localCameraDir = Cesium.Matrix4.multiplyByPointAsVector(
      inverseEnu,
      centerToCamera,
      new Cesium.Cartesian3()
    )
    Cesium.Cartesian3.normalize(localCameraDir, localCameraDir)

    // 更新中心点
    const centerPrimitive = this._axisPrimitives["CENTER"]
    if (centerPrimitive) {
      let centerScale = baseScale
      if (
        this._mode === "scale" &&
        this._isDragging &&
        this._dragAxisName === "CENTER"
      ) {
        centerScale *= this._activeScale.x
      }
      const scaleMatrix = Cesium.Matrix4.fromScale(
        new Cesium.Cartesian3(centerScale, centerScale, centerScale)
      )
      centerPrimitive.modelMatrix = Cesium.Matrix4.multiply(
        enuMatrix,
        scaleMatrix,
        new Cesium.Matrix4()
      )
    }

    const axes: ("X" | "Y" | "Z")[] = ["X", "Y", "Z"]
    const directions = {
      X: new Cesium.Cartesian3(1, 0, 0),
      Y: new Cesium.Cartesian3(0, 1, 0),
      Z: new Cesium.Cartesian3(0, 0, 1),
    }

    axes.forEach((axis) => {
      let axisDragScale = 1.0
      if (axis === "X") axisDragScale = this._activeScale.x
      if (axis === "Y") axisDragScale = this._activeScale.y
      if (axis === "Z") axisDragScale = this._activeScale.z

      const totalLen = baseScale * axisDragScale

      if (this._mode === "rotate") {
        // =========================================================
        // 【核心功能实现】旋转轴：根据相机视角切换象限
        // =========================================================
        const pFan = this._axisPrimitives[`${axis}_fan`]
        const pRim = this._axisPrimitives[`${axis}_rim`]

        if (pFan && pRim) {
          // 1. 计算当前轴平面上的视角角度
          let angle = 0
          let rotationAxis = Cesium.Cartesian3.UNIT_Z

          if (axis === "Z") {
            // Z轴控制：XY平面。计算 XY 平面上的角度。
            // Math.atan2(y, x) 返回 (-PI, PI)
            angle = Math.atan2(localCameraDir.y, localCameraDir.x)
            rotationAxis = Cesium.Cartesian3.UNIT_Z
          } else if (axis === "X") {
            // X轴控制：YZ平面。
            // 我们的几何体是 0->90 (Y->Z)，所以基准是 Y 轴
            angle = Math.atan2(localCameraDir.z, localCameraDir.y)
            rotationAxis = Cesium.Cartesian3.UNIT_X
          } else if (axis === "Y") {
            // Y轴控制：ZX平面。
            // 几何体是 0->90 (Z->X)，基准是 Z 轴
            angle = Math.atan2(localCameraDir.x, localCameraDir.z)
            rotationAxis = Cesium.Cartesian3.UNIT_Y
          }

          // 2. 象限吸附 (Snap to Quadrant)
          // 我们生成的扇形是 0~90 度。
          // 我们希望扇形的中心 (45度) 大致对准相机。
          // 算法：将角度减去 45度(PI/4)，然后除以 90度(PI/2) 取整，再乘回 90度。
          // 这样可以将 360 度分为 4 个离散的 90 度区间。
          const step = Math.PI / 2
          const snapAngle = Math.floor(angle / step) * step

          // 3. 构造旋转矩阵
          const quat = Cesium.Quaternion.fromAxisAngle(
            rotationAxis,
            snapAngle,
            new Cesium.Quaternion()
          )
          const quadrantRotation = Cesium.Matrix3.fromQuaternion(
            quat,
            new Cesium.Matrix3()
          )
          const quadrantMatrix =
            Cesium.Matrix4.fromRotationTranslation(quadrantRotation)

          // 4. 组合最终矩阵：ENU(定位) * Scale(缩放) * QuadrantRot(象限朝向)
          // 注意矩阵乘法顺序：先缩放，再自身旋转切换象限，最后定位到世界坐标
          const scaleM = Cesium.Matrix4.fromScale(
            new Cesium.Cartesian3(baseScale, baseScale, baseScale)
          )

          let m = Cesium.Matrix4.multiply(
            quadrantMatrix,
            scaleM,
            new Cesium.Matrix4()
          ) // Scale -> Rotate
          m = Cesium.Matrix4.multiply(enuMatrix, m, m) // -> World Position

          pFan.modelMatrix = m
          pRim.modelMatrix = m
        }
      } else {
        // ... (Translate/Scale 的原有逻辑保持不变) ...
        const lineScaleMatrix = Cesium.Matrix4.fromScale(
          new Cesium.Cartesian3(totalLen, totalLen, totalLen)
        )
        const lineModelMatrix = Cesium.Matrix4.multiply(
          enuMatrix,
          lineScaleMatrix,
          new Cesium.Matrix4()
        )

        let rotateMatrix = Cesium.Matrix4.IDENTITY
        if (this._mode === "translate") {
          if (axis === "X") {
            rotateMatrix = Cesium.Matrix4.fromRotationTranslation(
              Cesium.Matrix3.fromRotationY(Cesium.Math.toRadians(90))
            )
          } else if (axis === "Y") {
            rotateMatrix = Cesium.Matrix4.fromRotationTranslation(
              Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(-90))
            )
          }
        }

        const tipScaleMatrix = Cesium.Matrix4.fromScale(
          new Cesium.Cartesian3(baseScale, baseScale, baseScale)
        )
        const tipOffsetDist =
          this._mode === "translate" ? totalLen + 0.075 * baseScale : totalLen
        const offset = Cesium.Cartesian3.multiplyByScalar(
          directions[axis],
          tipOffsetDist,
          new Cesium.Cartesian3()
        )
        const translateMatrix = Cesium.Matrix4.fromTranslation(offset)

        let tipModelMatrix = Cesium.Matrix4.multiply(
          rotateMatrix,
          tipScaleMatrix,
          new Cesium.Matrix4()
        )
        tipModelMatrix = Cesium.Matrix4.multiply(
          translateMatrix,
          tipModelMatrix,
          tipModelMatrix
        )
        tipModelMatrix = Cesium.Matrix4.multiply(
          enuMatrix,
          tipModelMatrix,
          tipModelMatrix
        )

        const pLine = this._axisPrimitives[`${axis}_line`]
        const pTip =
          this._axisPrimitives[`${axis}_arrow`] ||
          this._axisPrimitives[`${axis}_box`]

        if (pLine) pLine.modelMatrix = lineModelMatrix
        if (pTip) pTip.modelMatrix = tipModelMatrix
      }
    })

    if (this._mode === "translate") {
      const planes = ["XY", "YZ", "ZX"]
      const planeScaleMatrix = Cesium.Matrix4.fromScale(
        new Cesium.Cartesian3(baseScale, baseScale, baseScale)
      )
      const planeModelMatrix = Cesium.Matrix4.multiply(
        enuMatrix,
        planeScaleMatrix,
        new Cesium.Matrix4()
      )

      planes.forEach((plane) => {
        const p = this._axisPrimitives[`PLANE_${plane}`]
        if (p) p.modelMatrix = planeModelMatrix
      })
    }
  }

  // ==================================================================================
  //                                  3. 交互事件处理 (RayCast 核心)
  // ==================================================================================

  /**
   * 几何射线检测
   */
  private rayCastGizmo(position: Cesium.Cartesian2): GizmoId | null {
    if (this._colliders.length === 0) return null

    const ray = this.viewer.scene.camera.getPickRay(position)
    if (!ray) return null

    let minDistance = Number.MAX_VALUE
    let closestId: GizmoId | null = null

    const inverseModelMatrix = new Cesium.Matrix4()
    const localRay = new Cesium.Ray()

    for (const collider of this._colliders) {
      const primitive = this._axisPrimitives[collider.primitiveKey]
      if (!primitive || !primitive.show) continue

      const modelMatrix = primitive.modelMatrix

      try {
        Cesium.Matrix4.inverse(modelMatrix, inverseModelMatrix)
      } catch (e) {
        continue
      }

      localRay.origin = Cesium.Matrix4.multiplyByPoint(
        inverseModelMatrix,
        ray.origin,
        new Cesium.Cartesian3()
      )
      localRay.direction = Cesium.Matrix4.multiplyByPointAsVector(
        inverseModelMatrix,
        ray.direction,
        new Cesium.Cartesian3()
      )

      const localAABB = new Cesium.AxisAlignedBoundingBox(
        collider.localMin,
        collider.localMax
      )
      const interval = Cesium.IntersectionTests.rayAxisAlignedBoundingBox(
        localRay,
        localAABB,
        new Cesium.Interval()
      ) as any

      if (interval) {
        // --- 扇形检测逻辑 ---
        if (collider.type === "SECTOR") {
          const t = interval.start
          const hitPoint = Cesium.Ray.getPoint(
            localRay,
            t,
            new Cesium.Cartesian3()
          )

          // 1. 距离中心检测 (剔除太远或太近的点)
          const r = collider.radius!
          // 因为包含扇形面，所以从 0 到 radius+buffer 都是有效区域
          // 如果你只想点中边框，这里要修改 logic
          // UE5 风格通常整个扇形都能点
          const buffer = (collider.tube || 0.05) * 4.0
          const dist = Cesium.Cartesian3.magnitude(hitPoint)

          if (dist > r + buffer) continue

          // 2. 角度检测 (限制在 0-90 度象限内)
          // 根据 ringNormalAxis 确定平面坐标
          let u = 0,
            v = 0
          if (collider.ringNormalAxis === 2) {
            u = hitPoint.x
            v = hitPoint.y
          } // XY (Z轴)
          if (collider.ringNormalAxis === 0) {
            u = hitPoint.y
            v = hitPoint.z
          } // YZ (X轴)
          if (collider.ringNormalAxis === 1) {
            u = hitPoint.z
            v = hitPoint.x
          } // ZX (Y轴)

          // 只有当 u, v 都为正时 (第一象限)，才算击中扇形
          // 稍微给点容差 -0.05
          if (u < -0.05 || v < -0.05) continue
        }

        let dist = interval.start
        if (collider.id.axis === "CENTER") {
          dist -= 1000.0
        }

        if (dist < minDistance) {
          minDistance = dist
          closestId = collider.id
        }
      }
    }

    return closestId
  }

  private initControlEvents() {
    if (this._handler) return // 防止重复绑定

    const scene = this.viewer.scene
    this._handler = new Cesium.ScreenSpaceEventHandler(scene.canvas)

    this._handler.setInputAction(
      (movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
        // 只有在有对象绑定时才响应
        if (!this.object) return

        if (this._isDragging) {
          this.handleDrag(movement.endPosition)
        } else {
          this.handleHover(movement.endPosition)
        }
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE
    )

    this._handler.setInputAction(
      (click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        if (!this.object) return
        this.handleDown(click.position)
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN
    )

    this._handler.setInputAction(() => {
      if (!this.object) return
      this.handleUp()
    }, Cesium.ScreenSpaceEventType.LEFT_UP)
  }

  private handleHover(position: Cesium.Cartesian2) {
    let pickedId = this.rayCastGizmo(position)
    if (!pickedId) {
      const picked = this.viewer.scene.pick(position)
      if (Cesium.defined(picked) && picked.id && picked.id.type) {
        if (picked.id.axis) pickedId = picked.id
      }
    }
    if (pickedId) {
      if (this._highlightedId !== pickedId) {
        this.restoreHighlight()
        this.highlightPrimitive(pickedId)
      }
    } else {
      this.restoreHighlight()
    }
  }

  private highlightPrimitive(id: GizmoId) {
    const targetPrimitives: any[] = []
    const axis = id.axis

    if (axis === "CENTER") {
      targetPrimitives.push(this._axisPrimitives["CENTER"])
    } else if (["XY", "YZ", "ZX"].includes(axis)) {
      targetPrimitives.push(this._axisPrimitives[`PLANE_${axis}`])
    } else {
      // 1. 尝试查找旋转轴的部件 (新版逻辑)
      if (this._axisPrimitives[`${axis}_rim`])
        targetPrimitives.push(this._axisPrimitives[`${axis}_rim`])

      // 2. 尝试查找平移/缩放轴的部件 (通用逻辑)
      const keys = [`${axis}_line`, `${axis}_arrow`, `${axis}_box`]
      keys.forEach((key) => {
        if (this._axisPrimitives[key])
          targetPrimitives.push(this._axisPrimitives[key])
      })
    }

    // 执行高亮：统一设为黄色
    targetPrimitives.forEach((p) => {
      if (!p) return
      const attributes = p.getGeometryInstanceAttributes(id)
      if (attributes) {
        // 高亮时，扇形也稍微加深一点透明度，甚至设为不透明，看你喜好
        // 这里设为纯黄，显眼
        attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
          Cesium.Color.YELLOW
        )
      }
    })

    this._highlightedId = id
  }

  private restoreHighlight() {
    if (this._highlightedId) {
      const id = this._highlightedId
      const axis = id.axis

      // 1. 确定原始颜色
      let baseColor: Cesium.Color
      if (axis === "CENTER") {
        baseColor = Cesium.Color.WHITE
      } else if (["XY", "YZ", "ZX"].includes(axis)) {
        // 平面颜色需特殊处理
        if (axis === "XY") baseColor = this.colors["Z"]
        else if (axis === "YZ") baseColor = this.colors["X"]
        else baseColor = this.colors["Y"] // ZX -> Y
      } else {
        // X, Y, Z 轴的标准颜色
        // @ts-ignore
        baseColor = this.colors[axis] || Cesium.Color.WHITE
      }

      // 2. 查找所有相关图元并分别还原
      // 我们需要分别处理，因为 Fan (扇形) 需要透明度，而其他不需要

      // --- 处理旋转轴 (Fan & Rim) ---
      const pFan = this._axisPrimitives[`${axis}_fan`]
      const pRim = this._axisPrimitives[`${axis}_rim`]

      if (pFan) {
        const attr = pFan.getGeometryInstanceAttributes(id)
        if (attr) {
          // 扇形还原为 0.2 透明度
          attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(
            baseColor.withAlpha(0.2)
          )
        }
      }
      if (pRim) {
        const attr = pRim.getGeometryInstanceAttributes(id)
        if (attr) {
          // 边框还原为不透明
          attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(baseColor)
        }
      }

      // --- 处理其他部件 (Line, Arrow, Box, Center, Plane) ---
      const otherKeys = [
        `${axis}_line`,
        `${axis}_arrow`,
        `${axis}_box`,
        `PLANE_${axis}`,
        "CENTER",
      ]
      otherKeys.forEach((key) => {
        const p = this._axisPrimitives[key]
        if (p) {
          const attr = p.getGeometryInstanceAttributes(id)
          if (attr) {
            // 平面特殊处理透明度
            if (key.includes("PLANE")) {
              attr.color = Cesium.ColorGeometryInstanceAttribute.toValue(
                baseColor.withAlpha(0.5)
              )
            } else {
              attr.color =
                Cesium.ColorGeometryInstanceAttribute.toValue(baseColor)
            }
          }
        }
      })

      this._highlightedId = null
    }
  }

  private handleDown(position: Cesium.Cartesian2) {
    let pickedId = this.rayCastGizmo(position)
    if (!pickedId) {
      const picked = this.viewer.scene.pick(position)
      if (Cesium.defined(picked) && picked.id && picked.id.type) {
        pickedId = picked.id
      }
    }
    if (pickedId) {
      this.startDrag(pickedId, position)
    }
  }

  private startDrag(id: GizmoId, position: Cesium.Cartesian2) {
    if (id.axis === "CENTER" && this._mode !== "scale") return

    this.viewer.scene.screenSpaceCameraController.enableRotate = false
    this.viewer.scene.screenSpaceCameraController.enableTranslate = false

    this._isDragging = true
    this._dragAxisName = id.name

    this.updateOutlineSelection()

    if (this.center) {
      this._dragStartCenter = this.center.clone()
      if (
        (this.object instanceof Cesium.Model ||
          this.object instanceof Cesium.Cesium3DTileset) &&
        this.object.modelMatrix
      ) {
        this._initialModelMatrix = this.object.modelMatrix.clone()
      } else {
        this._initialModelMatrix = Cesium.Matrix4.IDENTITY.clone()
      }

      const axisName = id.axis
      const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(this.center)
      let normal = new Cesium.Cartesian3()

      if (this._mode === "translate") {
        if (axisName === "XY")
          Cesium.Matrix4.getColumn(enuMatrix, 2, normal as any)
        else if (axisName === "YZ")
          Cesium.Matrix4.getColumn(enuMatrix, 0, normal as any)
        else if (axisName === "ZX")
          Cesium.Matrix4.getColumn(enuMatrix, 1, normal as any)
        else normal = this.viewer.scene.camera.direction
      } else if (this._mode === "scale" || axisName === "CENTER") {
        normal = this.viewer.scene.camera.direction
      } else if (this._mode === "rotate") {
        if (axisName === "X")
          Cesium.Matrix4.getColumn(enuMatrix, 0, normal as any)
        if (axisName === "Y")
          Cesium.Matrix4.getColumn(enuMatrix, 1, normal as any)
        if (axisName === "Z")
          Cesium.Matrix4.getColumn(enuMatrix, 2, normal as any)
      } else {
        if (axisName === "X")
          Cesium.Matrix4.getColumn(enuMatrix, 0, normal as any)
        if (axisName === "Y")
          Cesium.Matrix4.getColumn(enuMatrix, 1, normal as any)
        if (axisName === "Z")
          Cesium.Matrix4.getColumn(enuMatrix, 2, normal as any)
      }

      Cesium.Cartesian3.normalize(normal, normal)
      this._dragPlane = Cesium.Plane.fromPointNormal(this.center, normal)

      const ray = this.viewer.scene.camera.getPickRay(position)
      if (ray) {
        const intersect = Cesium.IntersectionTests.rayPlane(
          ray,
          this._dragPlane
        )
        if (intersect) {
          this._dragStartPoint = intersect
          this._dragVectorStart = Cesium.Cartesian3.subtract(
            intersect,
            this.center,
            new Cesium.Cartesian3()
          )
          Cesium.Cartesian3.normalize(
            this._dragVectorStart,
            this._dragVectorStart
          )
        }
      }
    }
  }

  private handleUp() {
    if (this._isDragging) {
      this._isDragging = false
      this.viewer.scene.screenSpaceCameraController.enableRotate = true
      this.viewer.scene.screenSpaceCameraController.enableTranslate = true
      this._activeScale = new Cesium.Cartesian3(1, 1, 1)

      if (this._edgeDetectionStage) this._edgeDetectionStage.selected = []
    }
  }

  // --- 业务计算逻辑 ---

  private handleDrag(position: Cesium.Cartesian2) {
    if (!this._dragPlane || !this.center) return
    const ray = this.viewer.scene.camera.getPickRay(position)
    if (!ray) return
    const newPoint = Cesium.IntersectionTests.rayPlane(ray, this._dragPlane)
    if (!newPoint) return

    if (this._mode === "translate") this.updateTranslate(newPoint)
    if (this._mode === "rotate") this.updateRotate(newPoint)
    if (this._mode === "scale") this.updateScale(newPoint)

    this.onUpdate && this.onUpdate(this.getTransformState())
  }

  private updateTranslate(newPoint: Cesium.Cartesian3) {
    const moveVector = Cesium.Cartesian3.subtract(
      newPoint,
      this._dragStartPoint,
      new Cesium.Cartesian3()
    )
    const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
      this._dragStartCenter
    )
    let offset = new Cesium.Cartesian3()
    const axisName = this._dragAxisName

    if (axisName.includes("PLANE")) {
      offset = moveVector
    } else {
      let axisVector = new Cesium.Cartesian3()
      const axis = axisName.split("_")[1]
      if (axis === "X")
        Cesium.Matrix4.getColumn(enuMatrix, 0, axisVector as any)
      if (axis === "Y")
        Cesium.Matrix4.getColumn(enuMatrix, 1, axisVector as any)
      if (axis === "Z")
        Cesium.Matrix4.getColumn(enuMatrix, 2, axisVector as any)
      Cesium.Cartesian3.normalize(axisVector, axisVector)

      const scalar = Cesium.Cartesian3.dot(moveVector, axisVector)
      offset = Cesium.Cartesian3.multiplyByScalar(
        axisVector,
        scalar,
        new Cesium.Cartesian3()
      )
    }

    const newCenter = Cesium.Cartesian3.add(
      this._dragStartCenter,
      offset,
      new Cesium.Cartesian3()
    )
    this.center = newCenter.clone()
    const translation = Cesium.Cartesian3.subtract(
      newCenter,
      this._dragStartCenter,
      new Cesium.Cartesian3()
    )
    const m = Cesium.Matrix4.fromTranslation(translation)

    if (
      this.object instanceof Cesium.Cesium3DTileset ||
      this.object instanceof Cesium.Model
    ) {
      Cesium.Matrix4.multiply(
        m,
        this._initialModelMatrix,
        this.object.modelMatrix
      )
    }
  }

  private updateRotate(newPoint: Cesium.Cartesian3) {
    const currentVector = Cesium.Cartesian3.subtract(
      newPoint,
      this.center!,
      new Cesium.Cartesian3()
    )
    Cesium.Cartesian3.normalize(currentVector, currentVector)

    const dot = Cesium.Cartesian3.dot(this._dragVectorStart, currentVector)
    let angle = Math.acos(Cesium.Math.clamp(dot, -1.0, 1.0))
    if (angle === 0) return

    const cross = Cesium.Cartesian3.cross(
      this._dragVectorStart,
      currentVector,
      new Cesium.Cartesian3()
    )
    const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(this.center!)
    let axisVector = new Cesium.Cartesian3()
    const axis = this._dragAxisName.split("_")[1]

    if (axis === "X") Cesium.Matrix4.getColumn(enuMatrix, 0, axisVector as any)
    if (axis === "Y") Cesium.Matrix4.getColumn(enuMatrix, 1, axisVector as any)
    if (axis === "Z") Cesium.Matrix4.getColumn(enuMatrix, 2, axisVector as any)
    Cesium.Cartesian3.normalize(axisVector, axisVector)

    const sign = Cesium.Cartesian3.dot(cross, axisVector)
    if (sign < 0) angle = -angle

    const quaternion = Cesium.Quaternion.fromAxisAngle(axisVector, angle)
    const rotationMatrix = Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromQuaternion(quaternion)
    )
    this.applyTransform(rotationMatrix)
  }

  private updateScale(newPoint: Cesium.Cartesian3) {
    const moveVector = Cesium.Cartesian3.subtract(
      newPoint,
      this._dragStartPoint,
      new Cesium.Cartesian3()
    )
    const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(this.center!)

    const pixelSize = this.viewer.camera.getPixelSize(
      new Cesium.BoundingSphere(this.center, 0),
      this.viewer.canvas.width,
      this.viewer.canvas.height
    )
    const currentLen = this.axisLength * pixelSize
    const sensitivity = 1.0 / currentLen
    let scaleFactor = 1.0

    if (this._dragAxisName === "CENTER") {
      const cameraUp = this.viewer.scene.camera.up
      const dragDist = Cesium.Cartesian3.dot(moveVector, cameraUp)
      scaleFactor = Math.max(0.01, 1.0 + dragDist * sensitivity * 2.0)
      this._activeScale.x = scaleFactor
      this._activeScale.y = scaleFactor
      this._activeScale.z = scaleFactor
      const scaleMatrix = Cesium.Matrix4.fromScale(
        new Cesium.Cartesian3(scaleFactor, scaleFactor, scaleFactor)
      )
      this.applyTransform(scaleMatrix)
    } else {
      let axisVector = new Cesium.Cartesian3()
      const axis = this._dragAxisName.split("_")[1]
      if (axis === "X")
        Cesium.Matrix4.getColumn(enuMatrix, 0, axisVector as any)
      if (axis === "Y")
        Cesium.Matrix4.getColumn(enuMatrix, 1, axisVector as any)
      if (axis === "Z")
        Cesium.Matrix4.getColumn(enuMatrix, 2, axisVector as any)
      Cesium.Cartesian3.normalize(axisVector, axisVector)

      const dragDist = Cesium.Cartesian3.dot(moveVector, axisVector)
      scaleFactor = Math.max(0.01, 1.0 + dragDist * sensitivity)

      if (axis === "X") this._activeScale.x = scaleFactor
      if (axis === "Y") this._activeScale.y = scaleFactor
      if (axis === "Z") this._activeScale.z = scaleFactor

      const rotationR = Cesium.Matrix4.getMatrix3(
        enuMatrix,
        new Cesium.Matrix3()
      )
      const scaleVec = new Cesium.Cartesian3(1, 1, 1)
      if (axis === "X") scaleVec.x = scaleFactor
      if (axis === "Y") scaleVec.y = scaleFactor
      if (axis === "Z") scaleVec.z = scaleFactor

      const localScale = Cesium.Matrix3.fromScale(scaleVec)
      const rotationR_T = Cesium.Matrix3.transpose(
        rotationR,
        new Cesium.Matrix3()
      )
      const temp = Cesium.Matrix3.multiply(
        localScale,
        rotationR_T,
        new Cesium.Matrix3()
      )
      const orientedScale = Cesium.Matrix3.multiply(
        rotationR,
        temp,
        new Cesium.Matrix3()
      )
      const scaleMatrix = Cesium.Matrix4.fromRotationTranslation(orientedScale)
      this.applyTransform(scaleMatrix)
    }
  }

  private applyTransform(transformMatrix: Cesium.Matrix4) {
    if (!this.center) return
    const toOrigin = Cesium.Matrix4.fromTranslation(
      Cesium.Cartesian3.negate(this.center, new Cesium.Cartesian3())
    )
    const toCenter = Cesium.Matrix4.fromTranslation(this.center)
    let m = Cesium.Matrix4.multiply(
      transformMatrix,
      toOrigin,
      new Cesium.Matrix4()
    )
    m = Cesium.Matrix4.multiply(toCenter, m, m)
    if (
      this.object instanceof Cesium.Cesium3DTileset ||
      this.object instanceof Cesium.Model
    ) {
      Cesium.Matrix4.multiply(
        m,
        this._initialModelMatrix,
        this.object.modelMatrix
      )
    }
  }
}

/**
 * 变换模式枚举
 */
export type TransformMode = "translate" | "rotate" | "scale"

/**
 * 初始化参数接口
 * @interface Options
 * @property {Cesium.Viewer} viewer - Cesium Viewer 实例
 * @property {Cesium.Model | Cesium.Cesium3DTileset} [object] - 需要进行变换操作的模型或3DTileset对象
 * @property {number} [axisWidth] - 轴线的宽度，默认为 5
 * @property {TransformMode} [mode] - 初始变换模式 ('translate', 'rotate', 'scale')
 * @property {(e: TransformState | null) => void} [onUpdate] - 变换状态更新时的回调函数
 */
interface Options {
  viewer: Cesium.Viewer
  object?: Cesium.Model | Cesium.Cesium3DTileset
  axisWidth?: number
  mode?: TransformMode
  onUpdate?: (e: TransformState | null) => void
}

/**
 * ID 结构
 */
interface GizmoId {
  axis: "X" | "Y" | "Z" | "XY" | "YZ" | "ZX" | "CENTER"
  type: TransformMode | "center"
  name: string
}

/**
 * 碰撞体类型
 * BOX: 实心盒子
 * SECTOR: 扇形区域 (包含圆弧管和扇形面)
 */
type ColliderType = "BOX" | "SECTOR"

/**
 * 碰撞体结构
 */
interface GizmoCollider {
  id: GizmoId
  type: ColliderType
  localMin: Cesium.Cartesian3
  localMax: Cesium.Cartesian3
  primitiveKey: string
  // SECTOR 类型专用参数
  radius?: number
  tube?: number // 管径
  ringNormalAxis?: 0 | 1 | 2 // 法向量轴: 0=X, 1=Y, 2=Z
  startAngle?: number // 起始弧度
  endAngle?: number // 结束弧度
}

/**
 * 变换状态数据结构
 * @interface TransformState
 * @property {Object} position - 位置坐标
 * @property {number} position.x - X轴位置
 * @property {number} position.y - Y轴位置
 * @property {number} position.z - Z轴位置
 * @property {Object} rotation - 旋转角度（欧拉角）
 * @property {number} rotation.heading - 偏航角 (Heading), 绕 Z 轴旋转
 * @property {number} rotation.pitch - 俯仰角 (Pitch), 绕 Y 轴旋转
 * @property {number} rotation.roll - 翻滚角 (Roll), 绕 X 轴旋转
 * @property {Object} scale - 缩放比例
 * @property {number} scale.x - X轴缩放
 * @property {number} scale.y - Y轴缩放
 * @property {number} scale.z - Z轴缩放
 */
interface TransformState {
  position: {
    x: number
    y: number
    z: number
  }
  rotation: {
    heading: number // 绕 Z 轴
    pitch: number // 绕 Y 轴
    roll: number // 绕 X 轴
  }
  scale: {
    x: number
    y: number
    z: number
  }
}
