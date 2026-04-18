"""
LIVP Extractor 配置文件
所有性能和并发相关的配置参数都在这里
"""

class Config:
    """LIVP提取器配置类"""

    # ==================== 并发配置 ====================

    # 外层并发配置(处理多个LIVP文件)
    # 针对高性能目标(15文件/秒)优化 - 大幅增加并发
    OUTER_MAX_WORKERS = 24  # 充分利用12线程的并发能力

    # 外层并发文件数: 基于32GB RAM大幅增加并行度
    OUTER_CONCURRENT_FILES = 32  # 大幅增加并发文件数

    # 内层并发配置(处理单个LIVP内的HEIC/MOV文件)
    # 内层工作线程数: 增加单个文件处理并发
    INNER_MAX_WORKERS = 6  # 增加内层并发处理能力

    # ==================== 批次处理配置 ====================

    # 批次大小: 线程数的倍数,确保线程池始终满载
    BATCH_SIZE_MULTIPLIER = 6  # 批次大小 = 线程数 * 4

    # 批次大小上限
    BATCH_SIZE_MAX = 100  # 最多100个任务/批次

    # ==================== I/O配置 ====================

    # 文件复制缓冲区大小(字节) - 针对NVMe SSD优化
    FILE_COPY_BUFFER_SIZE = 16 * 1024 * 1024  # 32MB (适应NVMe SSD高速I/O)

    # ==================== 内存配置 ====================

    # 每个文件预计占用的内存(MB) - 针对32GB RAM优化
    MEMORY_PER_FILE_MB = 256  # 增加单个文件内存配额

    # 内存使用率阈值(%),超过则降低并发数
    MEMORY_USAGE_THRESHOLD = 90  # 降低阈值，避免内存压力导致性能下降

    # ==================== 性能监控配置 ====================

    # 是否启用性能监控
    ENABLE_PERFORMANCE_MONITORING = True

    # 性能报告间隔(秒)
    PERFORMANCE_REPORT_INTERVAL = 5

    # ==================== 日志配置 ====================

    # 日志级别 - 性能优化阶段使用WARNING级别
    LOG_LEVEL = "WARNING"  # 减少日志开销，提高性能

    # 是否减少高频日志输出
    REDUCE_VERBOSE_LOGGING = True  # 启用高频日志抑制

    # ==================== 输出配置 ====================

    # 是否导出时间轴JPEG
    EXPORT_TIMELINE_JPEG = True

    # 时间轴JPEG质量(1-100)
    TIMELINE_JPEG_QUALITY = 85

    # Web资源前缀
    WEB_ASSET_PREFIX = "/assets"

    # ==================== 元数据配置 ====================

    # 是否提取GPS信息
    EXTRACT_GPS = True

    # 是否提取天气信息
    EXTRACT_WEATHER = True

    # 天气API超时(秒)
    WEATHER_API_TIMEOUT = 10

    # ==================== 文件处理配置 ====================

    # 是否跳过已存在的文件
    SKIP_EXISTING_FILES = False

    # 是否覆盖已存在的文件
    OVERWRITE_EXISTING_FILES = True

    # 是否保留原始文件名
    PRESERVE_ORIGINAL_FILENAME = True

    # ==================== 时间轴配置 ====================

    # 是否生成时间轴JSON
    GENERATE_TIMELINE = True

    # 是否合并所有时间轴
    MERGE_TIMELINES = True

    # ==================== 错误处理配置 ====================

    # 遇到错误时是否继续处理
    CONTINUE_ON_ERROR = True

    # 最大重试次数
    MAX_RETRY_COUNT = 3

    # 重试间隔(秒)
    RETRY_INTERVAL = 1
